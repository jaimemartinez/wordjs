// @ts-nocheck
"use client";

/**
 * Transport (2.11.0) — buses sold to attendees APART from the participation fee.
 *
 * A bus is a trip (origin → destination, departure) with seats and a price. Selling a seat creates a
 * ticket at the bus price; the ticket is paid with its own transport payments (cash / transfer) and has
 * its own payment status. Nothing here touches the inscription's fee, payments or balance.
 *
 * Staff roles (2.15.0): Transporte › ver reads buses, passengers and ticket payments; › gestionar creates
 * / edits / deletes buses, sells and removes seats and records / deletes ticket payments. The Excel
 * files are a «Reportes» permission. Administrators see everything.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { conferenceApi, PAYMENT_METHODS, fmtMoney } from "../lib/conference";
import type { Bus, TransportTicket, TransportPayment, Inscription, ConferenceField, Location } from "../lib/conference";
import { buildXlsx, downloadXlsx } from "../lib/xlsx";
import { buildBusManifest, displayName, exportFilename, withoutColumn } from "../lib/exports";
import { usePerms, ReadOnlyNotice } from "./perms";
import { Overlay } from "./Overlay";
import { canAutoFocus } from "../lib/overlay";

const money = (n: unknown) => '$' + fmtMoney(Number(n) || 0);
const fmtWhen = (v?: string | null) => {
    // A server stamp (CURRENT_TIMESTAMP, 'YYYY-MM-DD HH:MM:SS') is UTC — show it in local time.
    const stamp = String(v || '').match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
    if (stamp) {
        const dt = new Date(`${stamp[1]}T${stamp[2]}Z`);
        if (!isNaN(dt.getTime())) return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
    }
    const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}:${m[5]}` : ''}` : '';
};
const PAY_META: Record<string, { key: string; fallback: string; cls: string }> = {
    paid: { key: 'paid', fallback: 'Pagado', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    partial: { key: 'partial', fallback: 'Parcial', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    unpaid: { key: 'unpaid', fallback: 'Pendiente', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
};
const inputCls = 'w-full border-2 border-gray-100 rounded-xl px-4 py-3 bg-gray-50/30 focus:bg-white focus:border-blue-500 transition-all outline-none text-gray-900 font-medium text-sm';
const labelCls = 'block text-[10px] font-black text-gray-400 uppercase tracking-widest ml-1';

function Modal({ title, subtitle, onClose, children, footer, wide }: any) {
    return (
        <Overlay layer={2}>
            <div className={`bg-white rounded-[40px] shadow-2xl w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} border border-gray-100 overflow-hidden animate-in zoom-in-95 duration-200 max-h-[92vh] flex flex-col`} role="dialog" aria-modal="true">
                <div className="bg-gray-50/50 px-8 py-6 border-b border-gray-100 flex items-start justify-between gap-4 shrink-0">
                    <div className="min-w-0">
                        <h3 className="font-black text-2xl text-gray-900 italic tracking-tighter truncate">{title}</h3>
                        {subtitle && <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest mt-1 truncate">{subtitle}</p>}
                    </div>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors p-2 hover:bg-gray-100 rounded-2xl" aria-label="Cerrar">
                        <i className="fa-solid fa-xmark text-xl"></i>
                    </button>
                </div>
                <div className="p-6 sm:p-8 space-y-5 overflow-y-auto">{children}</div>
                {footer && <div className="px-6 sm:px-8 py-5 border-t border-gray-50 bg-gray-50/30 flex flex-wrap justify-end gap-3 shrink-0">{footer}</div>}
            </div>
        </Overlay>
    );
}

export default function TransportPage({ conferenceId, slug }: { conferenceId: number; slug?: string }) {
    const { t } = useI18n();
    const { addToast } = useToast();
    const perms = usePerms();
    const canManage = perms.can('transport', 'manage');
    const canExcel = perms.can('reports');
    const [buses, setBuses] = useState<Bus[]>([]);
    const [people, setPeople] = useState<Inscription[]>([]);
    const [fields, setFields] = useState<ConferenceField[]>([]);
    const [locations, setLocations] = useState<Location[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);

    // bus create / edit
    const emptyForm = { name: '', origin: '', destination: '', departure: '', capacity: '', price: '', notes: '' };
    const [busForm, setBusForm] = useState<any>(null); // { id?: number, ...fields, reprice: boolean }
    // passengers of one bus + the "add" selection
    const [passengersFor, setPassengersFor] = useState<number | null>(null);
    const [adding, setAdding] = useState(false);
    const [pick, setPick] = useState<Set<number>>(new Set());
    const [search, setSearch] = useState('');
    const [locFilter, setLocFilter] = useState('');
    // payments of one ticket
    const [payTicket, setPayTicket] = useState<TransportTicket | null>(null);
    const [payments, setPayments] = useState<TransportPayment[]>([]);
    const [payForm, setPayForm] = useState({ amount: '', method: PAYMENT_METHODS[0], reference: '', date: '' });
    // local confirm (rendered above the modals)
    const [confirmState, setConfirmState] = useState<{ text: string; onOk: () => void } | null>(null);

    const load = async () => {
        try {
            // The buses are this page; attendees / fields / locations only name the passengers, so a role
            // that may not read them still gets its buses (passengers then show as «#id»).
            const [b, p, f, l] = await Promise.all([
                conferenceApi.getBuses(conferenceId),
                conferenceApi.getInscriptions(conferenceId).catch(() => []),
                conferenceApi.getFields(conferenceId).catch(() => []),
                conferenceApi.getLocations(conferenceId).catch(() => null),
            ]);
            setBuses(b || []); setPeople(p || []); setFields(f || []); setLocations(l?.locations || []);
        } catch (e: any) {
            addToast(e?.message || 'Error', 'error');
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => { setLoading(true); load(); }, [conferenceId]);

    const personById = useMemo(() => new Map(people.map((p: any) => [Number(p.id), p])), [people]);
    const nameOf = (id: number) => { const p = personById.get(Number(id)); return p ? displayName(p, fields as any) : `#${id}`; };
    const currentBus = buses.find(b => b.id === passengersFor) || null;
    const totals = useMemo(() => buses.reduce((a, b) => ({
        seats: a.seats + (Number(b.capacity) || 0), sold: a.sold + (Number(b.sold) || 0),
        revenue: a.revenue + (Number(b.revenue) || 0), collected: a.collected + (Number(b.collected) || 0),
    }), { seats: 0, sold: 0, revenue: 0, collected: 0 }), [buses]);

    const run = async (fn: () => Promise<any>, ok?: string) => {
        setBusy(true);
        try { await fn(); if (ok) addToast(ok, 'success'); await load(); return true; }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); return false; }
        finally { setBusy(false); }
    };

    // ── bus form
    const openCreate = () => setBusForm({ ...emptyForm, reprice: false });
    const openEdit = (b: Bus) => setBusForm({
        id: b.id, name: b.name || '', origin: b.origin || '', destination: b.destination || '',
        departure: String(b.departure || '').slice(0, 16).replace(' ', 'T'), capacity: String(b.capacity), price: String(b.price ?? ''), notes: b.notes || '',
        originalPrice: b.price, reprice: false,
    });
    const saveBus = async () => {
        const f = busForm;
        const data = { name: f.name, origin: f.origin, destination: f.destination, departure: f.departure || null, capacity: f.capacity, price: f.price === '' ? 0 : f.price, notes: f.notes };
        const ok = await run(() => f.id
            ? conferenceApi.updateBus(f.id, { ...data, reprice_tickets: !!f.reprice })
            : conferenceApi.createBus(conferenceId, data as any), f.id ? (t('transport.bus.saved') || 'Bus actualizado') : (t('transport.bus.created') || 'Bus creado'));
        if (ok) setBusForm(null);
    };
    const deleteBus = (b: Bus) => setConfirmState({
        text: (t('transport.bus.confirm.delete') || '¿Eliminar el bus «{name}»? Sus pasajes sin pagos se liberan.').replace('{name}', b.name),
        onOk: () => run(() => conferenceApi.deleteBus(b.id), t('transport.bus.deleted') || 'Bus eliminado'),
    });

    // ── passengers
    const onBus = useMemo(() => new Set((currentBus?.passengers || []).map(p => Number(p.inscription_id))), [currentBus]);
    const candidates = useMemo(() => {
        const q = search.trim().toLowerCase();
        return people.filter((p: any) => p.status !== 'cancelled' && !onBus.has(Number(p.id))
            && (!locFilter || String(p.location_id) === locFilter)
            && (!q || [displayName(p, fields as any), p.reg_code, p.location, p.document_number].some(v => String(v || '').toLowerCase().includes(q))));
    }, [people, onBus, search, locFilter, fields]);
    const free = currentBus ? Math.max(0, Number(currentBus.capacity) - (Number(currentBus.sold) || 0)) : 0;
    const togglePick = (id: number) => setPick(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const addPassengers = async () => {
        if (!currentBus || !pick.size) return;
        const ok = await run(() => conferenceApi.addPassengers(currentBus.id, [...pick]), (t('transport.passengers.added') || '{n} pasajes vendidos').replace('{n}', String(pick.size)));
        if (ok) { setPick(new Set()); setAdding(false); }
    };
    const removePassenger = (tk: TransportTicket) => setConfirmState({
        text: (t('transport.passenger.confirm.remove') || '¿Quitar a {name} de este bus?').replace('{name}', nameOf(tk.inscription_id)),
        onOk: () => run(() => conferenceApi.removePassenger(tk.bus_id, tk.inscription_id), t('transport.passenger.removed') || 'Pasajero quitado'),
    });

    // ── ticket payments
    const openPayments = async (tk: TransportTicket) => {
        setPayTicket(tk);
        setPayForm({ amount: String(Math.max(0, Math.round((Number(tk.price) - Number(tk.amount_paid)) * 100) / 100)), method: PAYMENT_METHODS[0], reference: '', date: '' });
        try { setPayments(await conferenceApi.getTicketPayments(tk.id)); } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
    };
    const refreshTicket = async (ticketId: number) => {
        const b = await conferenceApi.getBuses(conferenceId);
        setBuses(b || []);
        const tk = (b || []).flatMap(x => x.passengers || []).find(x => x.id === ticketId) || null;
        setPayTicket(tk);
        setPayments(await conferenceApi.getTicketPayments(ticketId));
        if (tk) setPayForm(f => ({ ...f, amount: String(Math.max(0, Math.round((Number(tk.price) - Number(tk.amount_paid)) * 100) / 100)), reference: '' }));
    };
    const addPayment = async () => {
        if (!payTicket) return;
        setBusy(true);
        try {
            await conferenceApi.addTicketPayment(payTicket.id, { amount: Number(payForm.amount), method: payForm.method, reference: payForm.reference || undefined, date: payForm.date || undefined });
            addToast(t('transport.payment.added') || 'Pago registrado', 'success');
            await refreshTicket(payTicket.id);
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setBusy(false); }
    };
    const deletePayment = (p: TransportPayment) => setConfirmState({
        text: (t('transport.payment.confirm.delete') || '¿Eliminar el pago de {amount}?').replace('{amount}', money(p.amount)),
        onOk: async () => {
            setBusy(true);
            try { await conferenceApi.deleteTransportPayment(p.id); addToast(t('transport.payment.deleted') || 'Pago eliminado', 'success'); if (payTicket) await refreshTicket(payTicket.id); }
            catch (e: any) { addToast(e?.message || 'Error', 'error'); }
            finally { setBusy(false); }
        },
    });

    // ── Excel
    const excel = (busId: number | null) => {
        try {
            const built = buildBusManifest({ buses: buses as any, people: people as any, fields: fields as any, onlyBusId: busId });
            const sheets = perms.can('inscriptions') ? built : withoutColumn(built, 'Código');
            const name = busId != null ? 'bus-' + String(buses.find(b => b.id === busId)?.name || busId).toLowerCase() : 'transporte';
            downloadXlsx(buildXlsx(sheets), exportFilename(name, slug));
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
    };

    if (loading) {
        return (
            <div className="text-center py-20">
                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{t('loading') || 'Cargando…'}</p>
            </div>
        );
    }

    const pending = totals.revenue - totals.collected;
    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            <ReadOnlyNotice section="transport" />
            {/* Header */}
            <div className="relative overflow-hidden bg-white rounded-3xl p-8 border border-gray-100 shadow-xl shadow-gray-100/50">
                <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 bg-sky-50/60 rounded-full blur-3xl pointer-events-none"></div>
                <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                    <div>
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 rounded-xl bg-sky-600 flex items-center justify-center text-white shadow-lg shadow-sky-200"><i className="fa-solid fa-bus"></i></div>
                            <span className="text-[10px] font-bold text-sky-600 uppercase tracking-[0.2em]">{t('transport') || 'Transporte'}</span>
                        </div>
                        <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter">{t('transport.title') || 'Buses y pasajes'}</h2>
                        <p className="text-xs text-gray-500 mt-1 max-w-xl">{t('transport.subtitle') || 'Se cobra aparte de la cuota de participación: cada pasaje tiene su propio precio, pagos y estado.'}</p>
                        <div className="flex flex-wrap gap-3 mt-4">
                            {[
                                [t('transport.stat.buses') || 'Buses', String(buses.length)],
                                [t('transport.stat.seats') || 'Puestos vendidos', `${totals.sold}/${totals.seats}`],
                                [t('transport.stat.sold') || 'Vendido', money(totals.revenue)],
                                [t('transport.stat.collected') || 'Recaudado', money(totals.collected)],
                                [t('transport.stat.pending') || 'Por cobrar', money(pending)],
                            ].map(([label, value]) => (
                                <div key={label} className="bg-gray-50/80 px-4 py-2.5 rounded-2xl border border-gray-100">
                                    <div className="text-sm font-black text-gray-900 leading-none">{value}</div>
                                    <div className="text-[8px] font-black text-gray-400 uppercase tracking-widest mt-1">{label}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {canExcel && <button onClick={() => excel(null)} disabled={!buses.length} className="px-6 py-4 rounded-2xl bg-white border-2 border-gray-100 text-emerald-700 hover:border-emerald-500 font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50">
                            <i className="fa-solid fa-file-excel mr-1.5"></i>{t('transport.excel') || 'Excel de transporte'}
                        </button>}
                        {canManage && <button onClick={openCreate} className="px-8 py-4 rounded-2xl bg-sky-600 text-white hover:bg-sky-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-sky-500/30 transition-all active:scale-95">
                            <i className="fa-solid fa-plus mr-1.5"></i>{t('transport.bus.new') || 'Nuevo bus'}
                        </button>}
                    </div>
                </div>
            </div>

            {/* Buses */}
            {buses.length === 0 ? (
                <div className="flex flex-col justify-center items-center py-20 bg-gray-50/50 border-2 border-dashed border-gray-100 rounded-3xl text-center px-6">
                    <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center text-gray-300 text-2xl shadow-sm mb-4"><i className="fa-solid fa-bus"></i></div>
                    <p className="text-gray-600 font-bold">{t('transport.empty') || 'Aún no hay buses.'}</p>
                    {canManage && <p className="text-xs text-gray-400 mt-1">{t('transport.empty.hint') || 'Crea un bus con su trayecto, salida, capacidad y precio para empezar a vender pasajes.'}</p>}
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {buses.map(b => {
                        const sold = Number(b.sold) || 0, cap = Number(b.capacity) || 0;
                        const pct = cap ? Math.min(100, Math.round((sold / cap) * 100)) : 0;
                        const route = [b.origin, b.destination].filter(Boolean).join(' → ');
                        return (
                            <div key={b.id} className="bg-white p-6 sm:p-8 rounded-[32px] border-2 border-gray-50 shadow-sm hover:border-sky-200 hover:shadow-xl transition-all">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex items-center gap-4 min-w-0">
                                        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-sky-50 to-blue-50 text-sky-600 flex items-center justify-center text-xl shadow-inner shrink-0"><i className="fa-solid fa-bus-simple"></i></div>
                                        <div className="min-w-0">
                                            <h3 className="text-2xl font-black text-gray-900 italic tracking-tighter truncate">{b.name}</h3>
                                            <div className="text-xs font-bold text-gray-500 truncate">{route || (t('transport.route.none') || 'Sin trayecto')}</div>
                                            {b.departure && <div className="text-[10px] font-black text-sky-600 uppercase tracking-widest mt-0.5"><i className="fa-regular fa-clock mr-1"></i>{fmtWhen(b.departure)}</div>}
                                        </div>
                                    </div>
                                    <div className="flex gap-1.5 shrink-0">
                                        {canExcel && <button onClick={() => excel(b.id)} title={t('transport.bus.excel') || 'Lista de pasajeros (Excel)'} className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-50 text-emerald-600 hover:bg-emerald-600 hover:text-white transition-all"><i className="fa-solid fa-file-excel text-xs"></i></button>}
                                        {canManage && <button onClick={() => openEdit(b)} title={t('edit') || 'Editar'} className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-50 text-gray-400 hover:bg-blue-600 hover:text-white transition-all"><i className="fa-solid fa-pen text-xs"></i></button>}
                                        {canManage && <button onClick={() => deleteBus(b)} title={t('delete') || 'Eliminar'} className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-50 text-gray-400 hover:bg-rose-600 hover:text-white transition-all"><i className="fa-solid fa-trash-can text-xs"></i></button>}
                                    </div>
                                </div>
                                <div className="mt-5">
                                    <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">
                                        <span>{t('transport.seats') || 'Puestos'}: {sold}/{cap}</span>
                                        <span>{money(b.price)} {t('transport.per.seat') || 'por puesto'}</span>
                                    </div>
                                    <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
                                        <div className={`h-full rounded-full ${pct >= 100 ? 'bg-rose-500' : pct >= 80 ? 'bg-amber-400' : 'bg-sky-500'}`} style={{ width: `${pct}%` }}></div>
                                    </div>
                                    <div className="grid grid-cols-3 gap-2 mt-4 text-center">
                                        {[[t('transport.stat.sold') || 'Vendido', money(b.revenue), 'text-gray-900'], [t('transport.stat.collected') || 'Recaudado', money(b.collected), 'text-emerald-600'], [t('transport.stat.pending') || 'Por cobrar', money((Number(b.revenue) || 0) - (Number(b.collected) || 0)), 'text-rose-600']].map(([l, v, c]) => (
                                            <div key={l} className="bg-gray-50/70 rounded-xl py-2">
                                                <div className={`text-sm font-black ${c}`}>{v}</div>
                                                <div className="text-[8px] font-black text-gray-400 uppercase tracking-widest">{l}</div>
                                            </div>
                                        ))}
                                    </div>
                                    {b.notes && <p className="text-[11px] text-gray-500 mt-3"><i className="fa-solid fa-note-sticky mr-1 text-gray-300"></i>{b.notes}</p>}
                                    <button onClick={() => { setPassengersFor(b.id); setAdding(false); setPick(new Set()); setSearch(''); setLocFilter(''); }} className="mt-5 w-full px-4 py-3 rounded-2xl bg-gray-900 text-white hover:bg-sky-600 font-black text-[10px] uppercase tracking-widest transition-all">
                                        <i className="fa-solid fa-users mr-1.5"></i>{t('transport.passengers') || 'Pasajeros'} ({sold})
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Bus form */}
            {busForm && canManage && (
                <Modal title={busForm.id ? (t('transport.bus.edit') || 'Editar bus') : (t('transport.bus.new') || 'Nuevo bus')} subtitle={t('transport.bus.form.subtitle') || 'Trayecto, salida, capacidad y precio'} onClose={() => setBusForm(null)}
                    footer={<>
                        <button onClick={() => setBusForm(null)} className="px-6 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{t('cancel') || 'Cancelar'}</button>
                        <button onClick={saveBus} disabled={busy || !busForm.name.trim() || !busForm.capacity} className="px-8 py-3 bg-sky-600 text-white rounded-2xl hover:bg-sky-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-sky-500/30 disabled:opacity-50">{t('save') || 'Guardar'}</button>
                    </>}>
                    <div className="space-y-1.5"><label htmlFor="bus-name" className={labelCls}>{t('transport.bus.name') || 'Nombre del bus'} *</label>
                        <input id="bus-name" className={inputCls} value={busForm.name} onChange={e => setBusForm({ ...busForm, name: e.target.value })} placeholder="Ej. Bus 1 — Ida" autoFocus={canAutoFocus()} /></div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5"><label htmlFor="bus-origin" className={labelCls}>{t('transport.origin') || 'Origen'}</label>
                            <input id="bus-origin" className={inputCls} value={busForm.origin} onChange={e => setBusForm({ ...busForm, origin: e.target.value })} /></div>
                        <div className="space-y-1.5"><label htmlFor="bus-destination" className={labelCls}>{t('transport.destination') || 'Destino'}</label>
                            <input id="bus-destination" className={inputCls} value={busForm.destination} onChange={e => setBusForm({ ...busForm, destination: e.target.value })} /></div>
                    </div>
                    <div className="space-y-1.5"><label htmlFor="bus-departure" className={labelCls}>{t('transport.departure') || 'Salida'}</label>
                        <input id="bus-departure" type="datetime-local" className={inputCls} value={busForm.departure} onChange={e => setBusForm({ ...busForm, departure: e.target.value })} /></div>
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1.5"><label htmlFor="bus-capacity" className={labelCls}>{t('transport.capacity') || 'Capacidad (puestos)'} *</label>
                            <input id="bus-capacity" type="number" min={1} step={1} className={inputCls} value={busForm.capacity} onChange={e => setBusForm({ ...busForm, capacity: e.target.value })} /></div>
                        <div className="space-y-1.5"><label htmlFor="bus-price" className={labelCls}>{t('transport.price') || 'Precio por puesto'}</label>
                            <input id="bus-price" type="number" min={0} step="0.01" className={inputCls} value={busForm.price} onChange={e => setBusForm({ ...busForm, price: e.target.value })} /></div>
                    </div>
                    {busForm.id && String(busForm.price) !== String(busForm.originalPrice) && (
                        <label className="flex items-start gap-3 px-4 py-3 rounded-2xl border-2 border-amber-100 bg-amber-50/50 cursor-pointer">
                            <input type="checkbox" checked={busForm.reprice} onChange={e => setBusForm({ ...busForm, reprice: e.target.checked })} className="accent-amber-600 w-4 h-4 mt-0.5" />
                            <span className="text-xs text-amber-900"><b>{t('transport.reprice') || 'Aplicar el nuevo precio a los pasajes ya vendidos'}</b><br />{t('transport.reprice.help') || 'Si no, el nuevo precio solo aplica a las próximas ventas.'}</span>
                        </label>
                    )}
                    <div className="space-y-1.5"><label htmlFor="bus-notes" className={labelCls}>{t('transport.notes') || 'Notas'}</label>
                        <textarea id="bus-notes" rows={2} className={inputCls + ' resize-none'} value={busForm.notes} onChange={e => setBusForm({ ...busForm, notes: e.target.value })} /></div>
                </Modal>
            )}

            {/* Passengers of a bus */}
            {currentBus && (
                <Modal wide title={currentBus.name} subtitle={`${t('transport.passengers') || 'Pasajeros'} · ${Number(currentBus.sold) || 0}/${currentBus.capacity} · ${money(currentBus.price)}`} onClose={() => setPassengersFor(null)}
                    footer={!canManage ? null : adding ? <>
                        <span className="mr-auto text-xs font-bold text-gray-500 self-center">{(t('transport.add.selected') || '{n} seleccionados · {free} puestos libres').replace('{n}', String(pick.size)).replace('{free}', String(free))}</span>
                        <button onClick={() => { setAdding(false); setPick(new Set()); }} className="px-6 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{t('cancel') || 'Cancelar'}</button>
                        <button onClick={addPassengers} disabled={busy || !pick.size || pick.size > free} className="px-8 py-3 bg-sky-600 text-white rounded-2xl hover:bg-sky-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-sky-500/30 disabled:opacity-50">{t('transport.add.confirm') || 'Vender pasajes'}</button>
                    </> : <>
                        <button onClick={() => setAdding(true)} disabled={free <= 0} className="px-8 py-3 bg-sky-600 text-white rounded-2xl hover:bg-sky-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-sky-500/30 disabled:opacity-50"><i className="fa-solid fa-user-plus mr-1.5"></i>{free <= 0 ? (t('transport.full') || 'Bus lleno') : (t('transport.add') || 'Agregar pasajeros')}</button>
                    </>}>
                    {adding && canManage ? (
                        <>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <input className={inputCls} value={search} onChange={e => setSearch(e.target.value)} placeholder={t('transport.add.search') || 'Buscar por nombre, código o documento…'} aria-label={t('transport.add.search') || 'Buscar'} />
                                <select className={inputCls} value={locFilter} onChange={e => setLocFilter(e.target.value)} aria-label={t('excel.filter.location') || 'Localidad'}>
                                    <option value="">{t('excel.filter.all') || 'Todas'}</option>
                                    {locations.map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                                </select>
                            </div>
                            {pick.size > free && <p className="text-xs font-bold text-rose-600">{(t('transport.add.too.many') || 'Solo quedan {free} puestos.').replace('{free}', String(free))}</p>}
                            <div className="rounded-2xl border border-gray-100 divide-y divide-gray-50 max-h-96 overflow-y-auto">
                                {candidates.length === 0 && <div className="px-4 py-8 text-center text-xs text-gray-400 italic">{t('transport.add.none') || 'No hay participantes disponibles.'}</div>}
                                {candidates.slice(0, 400).map((p: any) => (
                                    <label key={p.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-sky-50/50 cursor-pointer">
                                        <input type="checkbox" checked={pick.has(p.id)} onChange={() => togglePick(p.id)} className="accent-sky-600 w-4 h-4" aria-label={displayName(p, fields as any)} />
                                        <span className="flex-1 min-w-0">
                                            <span className="block text-sm font-bold text-gray-800 truncate">{displayName(p, fields as any)}</span>
                                            <span className="block text-[10px] text-gray-400 font-bold uppercase tracking-widest">{p.location || '—'}{p.reg_code ? ` · ${p.reg_code}` : ''}</span>
                                        </span>
                                    </label>
                                ))}
                                {candidates.length > 400 && <div className="px-4 py-3 text-center text-[11px] text-gray-400">{(t('board.showing') || 'Mostrando {n} de {total}').replace('{n}', '400').replace('{total}', String(candidates.length))}</div>}
                            </div>
                        </>
                    ) : (
                        <div className="rounded-2xl border border-gray-100 divide-y divide-gray-50 overflow-x-auto">
                            {(currentBus.passengers || []).length === 0 && <div className="px-4 py-10 text-center text-xs text-gray-400 italic">{t('transport.passengers.none') || 'Este bus aún no tiene pasajeros.'}</div>}
                            {(currentBus.passengers || []).map(tk => {
                                const meta = PAY_META[tk.payment_status] || PAY_META.unpaid;
                                const p: any = personById.get(Number(tk.inscription_id));
                                return (
                                    <div key={tk.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                                        <div className="flex-1 min-w-[10rem]">
                                            <div className="text-sm font-bold text-gray-800">{nameOf(tk.inscription_id)}</div>
                                            <div className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{p?.location || '—'}{p?.reg_code ? ` · ${p.reg_code}` : ''}</div>
                                        </div>
                                        <div className="text-right">
                                            <div className="text-xs font-black text-gray-700">{money(tk.amount_paid)} / {money(tk.price)}</div>
                                            <span className={`inline-block mt-0.5 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border ${meta.cls}`}>{t(meta.key) || meta.fallback}</span>
                                        </div>
                                        <button onClick={() => openPayments(tk)} title={t('transport.payments') || 'Pagos del pasaje'} className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-50 text-gray-400 hover:bg-emerald-600 hover:text-white transition-all"><i className="fa-solid fa-money-bill-wave text-xs"></i></button>
                                        {canManage && <button onClick={() => removePassenger(tk)} title={t('transport.passenger.remove') || 'Quitar del bus'} className="w-9 h-9 flex items-center justify-center rounded-xl bg-gray-50 text-gray-400 hover:bg-rose-600 hover:text-white transition-all"><i className="fa-solid fa-user-minus text-xs"></i></button>}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </Modal>
            )}

            {/* Payments of a ticket */}
            {payTicket && (
                <Modal title={t('transport.payments') || 'Pagos del pasaje'} subtitle={`${nameOf(payTicket.inscription_id)} · ${buses.find(b => b.id === payTicket.bus_id)?.name || ''}`} onClose={() => setPayTicket(null)}>
                    <div className="grid grid-cols-3 gap-2 text-center">
                        {[[t('transport.price') || 'Precio', money(payTicket.price), 'text-gray-900'], [t('paid') || 'Pagado', money(payTicket.amount_paid), 'text-emerald-600'], [t('transport.stat.pending') || 'Por cobrar', money(Number(payTicket.price) - Number(payTicket.amount_paid)), 'text-rose-600']].map(([l, v, c]) => (
                            <div key={l} className="bg-gray-50/70 rounded-xl py-3"><div className={`text-base font-black ${c}`}>{v}</div><div className="text-[8px] font-black text-gray-400 uppercase tracking-widest">{l}</div></div>
                        ))}
                    </div>
                    <div className="rounded-2xl border border-gray-100 divide-y divide-gray-50">
                        {payments.length === 0 && <div className="px-4 py-6 text-center text-xs text-gray-400 italic">{t('transport.payments.none') || 'Sin pagos registrados.'}</div>}
                        {payments.map(p => (
                            <div key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-black text-gray-800">{money(p.amount)} <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{p.method}</span></div>
                                    <div className="text-[10px] text-gray-400 font-bold">{fmtWhen(p.date)}{p.reference ? ` · ${p.reference}` : ''}</div>
                                </div>
                                {canManage && <button onClick={() => deletePayment(p)} title={t('delete') || 'Eliminar'} className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-50 text-gray-400 hover:bg-rose-600 hover:text-white transition-all"><i className="fa-solid fa-trash-can text-[10px]"></i></button>}
                            </div>
                        ))}
                    </div>
                    {canManage && Number(payTicket.price) - Number(payTicket.amount_paid) > 0.004 && (
                        <div className="space-y-3 rounded-2xl border-2 border-gray-100 p-4">
                            <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{t('transport.payment.new') || 'Registrar pago'}</div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <input type="number" min={0} step="0.01" className={inputCls} value={payForm.amount} onChange={e => setPayForm({ ...payForm, amount: e.target.value })} aria-label={t('amount') || 'Monto'} />
                                <select className={inputCls} value={payForm.method} onChange={e => setPayForm({ ...payForm, method: e.target.value })} aria-label={t('payment.methods') || 'Forma de pago'}>
                                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                                </select>
                                <input className={inputCls} value={payForm.reference} onChange={e => setPayForm({ ...payForm, reference: e.target.value })} placeholder={t('reference') || 'Referencia (opcional)'} aria-label={t('reference') || 'Referencia'} />
                                <input type="date" className={inputCls} value={payForm.date} onChange={e => setPayForm({ ...payForm, date: e.target.value })} aria-label={t('transport.payment.date') || 'Fecha del pago'} />
                            </div>
                            <button onClick={addPayment} disabled={busy || !(Number(payForm.amount) > 0)} className="w-full px-6 py-3 bg-emerald-600 text-white rounded-2xl hover:bg-emerald-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-emerald-500/30 disabled:opacity-50">
                                <i className="fa-solid fa-check mr-1.5"></i>{t('transport.payment.save') || 'Registrar pago'}
                            </button>
                        </div>
                    )}
                </Modal>
            )}

            {/* Local confirm — above every modal of this page */}
            {confirmState && (
                <Overlay layer={4} backdrop="rgba(0,0,0,0.5)" className="backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-5" role="alertdialog" aria-modal="true">
                        <p className="text-sm font-bold text-gray-800">{confirmState.text}</p>
                        <div className="flex justify-end gap-2">
                            <button onClick={() => setConfirmState(null)} className="px-5 py-2.5 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{t('cancel') || 'Cancelar'}</button>
                            <button onClick={() => { const f = confirmState.onOk; setConfirmState(null); f(); }} className="px-6 py-2.5 bg-rose-600 text-white rounded-xl hover:bg-rose-700 font-black text-[10px] uppercase tracking-widest">{t('confirm') || 'Confirmar'}</button>
                        </div>
                    </div>
                </Overlay>
            )}
        </div>
    );
}
