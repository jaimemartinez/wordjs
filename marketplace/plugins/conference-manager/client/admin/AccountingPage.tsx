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
 */
import React, { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { conferenceApi, PAYMENT_METHODS, fmtMoney } from "../lib/conference";
import { buildXlsx, downloadXlsx } from "../lib/xlsx";
import { displayName, exportFilename } from "../lib/exports";
import { filterLedger, summarizeLedger, buildLedgerWorkbook } from "../lib/accounting";
import { usePerms, ReadOnlyNotice } from "./perms";

const money = (n: unknown) => { const v = Number(n) || 0; return (v < 0 ? '-$' : '$') + fmtMoney(Math.abs(v)); };
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDay = (v?: string | null) => {
    const s = String(v || '');
    // a server stamp ('YYYY-MM-DD HH:MM:SS', UTC) → the local calendar day
    const stamp = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
    if (stamp) { const d = new Date(`${stamp[1]}T${stamp[2]}Z`); if (!isNaN(d.getTime())) return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; }
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
};
const inputCls = 'w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm';
const labelCls = 'block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1';

export default function AccountingPage({ conferenceId, slug }: { conferenceId: number; slug?: string }) {
    const { t } = useI18n();
    const { addToast } = useToast();
    const perms = usePerms();
    const canManage = perms.can('accounting', 'manage');
    const canExcel = perms.can('reports');
    const [data, setData] = useState<any>({ entries: [], totals: { income: 0, expense: 0, balance: 0 }, categories: { income: [], expense: [] } });
    const [people, setPeople] = useState<any[]>([]);
    const [fields, setFields] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [filter, setFilter] = useState({ from: '', to: '', kind: '', category: '', source: '', search: '' });
    const [form, setForm] = useState<any>(null); // { id?, kind, date, category, description, amount, method, reference }
    const [confirmState, setConfirmState] = useState<{ text: string; onOk: () => void } | null>(null);

    const load = async () => {
        try {
            // The ledger is this page; attendees / fields only name the payers, so a role that may not read
            // them still gets the ledger (those rows then show «#id»).
            const [d, p, f] = await Promise.all([conferenceApi.getLedger(conferenceId), conferenceApi.getInscriptions(conferenceId).catch(() => []), conferenceApi.getFields(conferenceId).catch(() => [])]);
            setData(d); setPeople(p || []); setFields(f || []);
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setLoading(false); }
    };
    useEffect(() => { setLoading(true); load(); }, [conferenceId]);

    const names = useMemo(() => new Map(people.map((p: any) => [Number(p.id), displayName(p, fields)])), [people, fields]);
    const rows = useMemo(() => filterLedger(data.entries || [], filter as any, names), [data, filter, names]);
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
        try { downloadXlsx(buildXlsx(buildLedgerWorkbook(rows as any, names)), exportFilename('contabilidad', slug)); }
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
    const formCategories = form ? (data.categories?.[form.kind] || []) : [];
    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            <ReadOnlyNotice section="accounting" />
            {/* Header */}
            <div className="relative overflow-hidden bg-white rounded-3xl p-8 border border-gray-100 shadow-xl shadow-gray-100/50">
                <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 bg-emerald-50/60 rounded-full blur-3xl pointer-events-none"></div>
                <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                    <div>
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 rounded-xl bg-emerald-600 flex items-center justify-center text-white shadow-lg shadow-emerald-200"><i className="fa-solid fa-scale-balanced"></i></div>
                            <span className="text-[10px] font-bold text-emerald-600 uppercase tracking-[0.2em]">{t('accounting') || 'Contabilidad'}</span>
                        </div>
                        <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter">{t('accounting.title') || 'Ingresos y egresos'}</h2>
                        <p className="text-xs text-gray-500 mt-1 max-w-xl">{t('accounting.subtitle') || 'Los pagos de inscripción validados y los pagos de transporte entran solos como ingresos; aquí registras todo lo demás.'}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {canExcel && <button onClick={excel} disabled={!rows.length} className="px-6 py-4 rounded-2xl bg-white border-2 border-gray-100 text-emerald-700 hover:border-emerald-500 font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50"><i className="fa-solid fa-file-excel mr-1.5"></i>{t('accounting.excel') || 'Excel'}</button>}
                        {canManage && <button onClick={() => openNew('expense')} className="px-6 py-4 rounded-2xl bg-rose-600 text-white hover:bg-rose-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-rose-500/30 transition-all active:scale-95"><i className="fa-solid fa-minus mr-1.5"></i>{t('accounting.new.expense') || 'Nuevo egreso'}</button>}
                        {canManage && <button onClick={() => openNew('income')} className="px-6 py-4 rounded-2xl bg-emerald-600 text-white hover:bg-emerald-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-emerald-500/30 transition-all active:scale-95"><i className="fa-solid fa-plus mr-1.5"></i>{t('accounting.new.income') || 'Nuevo ingreso'}</button>}
                    </div>
                </div>
                <div className="relative grid grid-cols-1 sm:grid-cols-3 gap-4 mt-6">
                    {[[t('accounting.income') || 'Ingresos', summary.income, 'text-emerald-600', 'fa-arrow-trend-up'], [t('accounting.expense') || 'Egresos', summary.expense, 'text-rose-600', 'fa-arrow-trend-down'], [t('accounting.balance') || 'Balance', summary.balance, summary.balance < 0 ? 'text-rose-600' : 'text-gray-900', 'fa-scale-balanced']].map(([label, value, cls, icon]: any) => (
                        <div key={label} className="bg-gray-50/80 px-5 py-4 rounded-2xl border border-gray-100">
                            <div className="text-[9px] font-black text-gray-400 uppercase tracking-widest"><i className={`fa-solid ${icon} mr-1`}></i>{label}{filtered ? ` · ${t('accounting.filtered') || 'filtrado'}` : ''}</div>
                            <div className={`text-2xl font-black italic tracking-tighter mt-1 ${cls}`}>{money(value)}</div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Filters */}
            <div className="bg-white rounded-3xl border border-gray-100 shadow-sm p-5 grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
                <div className="space-y-1"><label htmlFor="acc-from" className={labelCls}>{t('accounting.from') || 'Desde'}</label><input id="acc-from" type="date" className={inputCls} value={filter.from} onChange={e => setFilter({ ...filter, from: e.target.value })} /></div>
                <div className="space-y-1"><label htmlFor="acc-to" className={labelCls}>{t('accounting.to') || 'Hasta'}</label><input id="acc-to" type="date" className={inputCls} value={filter.to} onChange={e => setFilter({ ...filter, to: e.target.value })} /></div>
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
                <div className="space-y-1"><label htmlFor="acc-q" className={labelCls}>{t('accounting.search') || 'Buscar'}</label><input id="acc-q" className={inputCls} value={filter.search} onChange={e => setFilter({ ...filter, search: e.target.value })} placeholder={t('accounting.search.placeholder') || 'Descripción, referencia, participante…'} /></div>
                {filtered && <button onClick={() => setFilter({ from: '', to: '', kind: '', category: '', source: '', search: '' })} className="col-span-2 md:col-span-6 justify-self-end text-[10px] font-black uppercase tracking-widest text-gray-400 hover:text-gray-700 px-3 py-1.5"><i className="fa-solid fa-xmark mr-1"></i>{t('accounting.clear.filters') || 'Quitar filtros'}</button>}
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                {/* Movements */}
                <div className="xl:col-span-2 bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-100/30 overflow-hidden">
                    <div className="px-6 py-5 border-b border-gray-50 flex items-center justify-between">
                        <h3 className="text-xl font-black text-gray-900 italic tracking-tighter">{t('accounting.movements') || 'Movimientos'}</h3>
                        <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{rows.length}</span>
                    </div>
                    {rows.length === 0 ? (
                        <div className="py-16 text-center text-sm text-gray-400 italic">{t('accounting.empty') || 'No hay movimientos.'}</div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left">
                                <thead><tr className="bg-gray-50/50">
                                    {[t('accounting.date') || 'Fecha', t('accounting.description') || 'Descripción', t('accounting.category') || 'Categoría', t('payment.methods') || 'Forma de pago', t('accounting.amount') || 'Monto', ''].map((h, i) => <th key={i} scope="col" className={`px-5 py-4 text-[10px] font-black text-gray-400 uppercase tracking-widest whitespace-nowrap ${i === 4 ? 'text-right' : ''}`}>{h}</th>)}
                                </tr></thead>
                                <tbody className="divide-y divide-gray-50">
                                    {rows.map((e: any) => (
                                        <tr key={e.id} className="hover:bg-blue-50/30 transition-colors group/row">
                                            <td className="px-5 py-3 whitespace-nowrap text-xs font-bold text-gray-500">{fmtDay(e.date)}</td>
                                            <td className="px-5 py-3">
                                                <div className="font-bold text-gray-900">{e.description}</div>
                                                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                                                    {sourceLabel(e.source)}{e.inscription_id != null ? ` · ${names.get(Number(e.inscription_id)) || '#' + e.inscription_id}` : ''}{e.reference ? ` · ${e.reference}` : ''}
                                                </div>
                                            </td>
                                            <td className="px-5 py-3 text-xs font-medium text-gray-600 whitespace-nowrap">{e.category || '—'}</td>
                                            <td className="px-5 py-3 text-xs font-medium text-gray-600 whitespace-nowrap">{e.method || '—'}</td>
                                            <td className={`px-5 py-3 text-right font-black whitespace-nowrap ${e.kind === 'income' ? 'text-emerald-600' : 'text-rose-600'}`}>{e.kind === 'income' ? '+' : '−'}{money(e.amount)}</td>
                                            <td className="px-5 py-3 text-right whitespace-nowrap">
                                                {!canManage ? null : e.readonly ? (
                                                    <span title={t('accounting.readonly') || 'Se gestiona desde los pagos de la inscripción o del pasaje'} className="text-gray-300"><i className="fa-solid fa-lock text-xs"></i></span>
                                                ) : (
                                                    <div className="flex justify-end gap-1.5 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
                                                        <button onClick={() => openEdit(e)} title={t('edit') || 'Editar'} className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white transition-all"><i className="fa-solid fa-pen text-[10px]"></i></button>
                                                        <button onClick={() => remove(e)} title={t('delete') || 'Eliminar'} className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-50 text-gray-400 hover:bg-rose-600 hover:text-white transition-all"><i className="fa-solid fa-trash-can text-[10px]"></i></button>
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
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
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4 animate-in fade-in duration-200">
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
                                <input id="acc-desc" className={inputCls} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} autoFocus /></div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1.5"><label htmlFor="acc-amount" className={labelCls}>{t('accounting.amount') || 'Monto'} *</label>
                                    <input id="acc-amount" type="number" min={0} step="0.01" className={inputCls} value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></div>
                                <div className="space-y-1.5"><label htmlFor="acc-date" className={labelCls}>{t('accounting.date') || 'Fecha'} *</label>
                                    <input id="acc-date" type="date" className={inputCls} value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></div>
                            </div>
                            <div className="space-y-1.5"><label htmlFor="acc-category" className={labelCls}>{t('accounting.category') || 'Categoría'}</label>
                                <input id="acc-category" list="acc-categories" className={inputCls} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} placeholder={t('accounting.category.placeholder') || 'Elige o escribe una categoría'} />
                                <datalist id="acc-categories">{formCategories.map((c: string) => <option key={c} value={c} />)}</datalist></div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1.5"><label htmlFor="acc-method" className={labelCls}>{t('payment.methods') || 'Forma de pago'}</label>
                                    <select id="acc-method" className={inputCls} value={form.method} onChange={e => setForm({ ...form, method: e.target.value })}>
                                        <option value="">—</option>{PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
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
                </div>
            )}

            {confirmState && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[130] flex items-center justify-center p-4">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-5" role="alertdialog" aria-modal="true">
                        <p className="text-sm font-bold text-gray-800">{confirmState.text}</p>
                        <div className="flex justify-end gap-2">
                            <button onClick={() => setConfirmState(null)} className="px-5 py-2.5 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{t('cancel') || 'Cancelar'}</button>
                            <button onClick={() => { const f = confirmState.onOk; setConfirmState(null); f(); }} className="px-6 py-2.5 bg-rose-600 text-white rounded-xl hover:bg-rose-700 font-black text-[10px] uppercase tracking-widest">{t('confirm') || 'Confirmar'}</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
