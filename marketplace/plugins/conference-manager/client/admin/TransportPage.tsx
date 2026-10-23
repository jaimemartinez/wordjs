// @ts-nocheck
"use client";

/**
 * Transport (2.11.0; packages 2.26.0) — sold to attendees APART from the participation fee.
 *
 * A bus is a trip (origin → destination, departure) with seats. What is SOLD is a PACKAGE: a fixed list of buses
 * (e.g. «Ida y regreso» = Bus 1 + Bus 4) with one price. Selling a package to a person seats them on every bus of
 * the list (all-or-nothing, never beyond a bus's seats) and creates the sale, which is paid with its own payments
 * (cash / transfer) and has its own status. Nothing here touches the inscription's fee, payments or balance.
 *
 * Staff roles (2.15.0): Transporte › ver reads buses, packages, passengers and payments; › gestionar creates /
 * edits / deletes buses and packages, sells and takes packages away and records / deletes payments. The Excel
 * files are a «Reportes» permission. Administrators see everything.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../../frontend/src/contexts/I18nContext";
import { useToast } from "../../../../../frontend/src/contexts/ToastContext";
import { conferenceApi, PAYMENT_METHODS, fmtMoney } from "../lib/conference";
import { DateField } from "../lib/DateField";
import { paymentMethodLabel } from "../lib/labels";
import type { Bus, BusNotice, NoticeResult, TransportPackage, PackageSale, PackagePayment, Inscription, ConferenceField, Location } from "../lib/conference";
import { buildXlsx, downloadXlsx } from "../lib/xlsx";
import { buildBusManifest, displayName, exportFilename, withoutColumn } from "../lib/exports";
import { usePerms, ReadOnlyNotice } from "./perms";
import { Overlay } from "./Overlay";
import { canAutoFocus } from "../lib/overlay";
import { BoardingScanner } from "./BoardingScanner";
import { Select } from "../lib/Select";

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
/** A moment as the hour on this computer («3:05 p. m.»), or '' when missing. */
const fmtClock = (iso?: string | null) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    try { return new Intl.DateTimeFormat('es', { hour: 'numeric', minute: '2-digit' }).format(d); } catch { return d.toLocaleTimeString(); }
};
const iconBtn = 'w-9 h-9 shrink-0 flex items-center justify-center rounded-xl bg-gray-50 transition-all';

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

function Stat({ label, value, cls = 'text-gray-900' }: any) {
    return (
        <div className="bg-gray-50/70 rounded-xl py-2 px-2 text-center min-w-0">
            <div className={`text-sm font-black ${cls}`} style={{ overflowWrap: 'anywhere' }}>{value}</div>
            <div className="text-[8px] font-black text-gray-400 uppercase tracking-widest">{label}</div>
        </div>
    );
}

export default function TransportPage({ conferenceId, slug }: { conferenceId: number; slug?: string }) {
    const { t } = useI18n();
    const tt = (k: string, fb: string) => t(k) || fb;
    const { addToast } = useToast();
    const perms = usePerms();
    const canManage = perms.can('transport', 'manage');
    const canExcel = perms.can('reports');
    const [buses, setBuses] = useState<Bus[]>([]);
    const [packages, setPackages] = useState<TransportPackage[]>([]);
    // «Verificar abordaje» (2.25.0): the bus the scanner opens on, or null = closed.
    const [boarding, setBoarding] = useState<number | null>(null);
    const [people, setPeople] = useState<Inscription[]>([]);
    const [fields, setFields] = useState<ConferenceField[]>([]);
    const [locations, setLocations] = useState<Location[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);

    const [busForm, setBusForm] = useState<any>(null);          // { id?, name, origin, destination, departure, capacity, notes }
    const [pkgForm, setPkgForm] = useState<any>(null);          // { id?, name, price, notes, bus_ids:Set, originalPrice, sold, reprice }
    const [passengersFor, setPassengersFor] = useState<number | null>(null);   // bus id (read-only list)
    const [salesFor, setSalesFor] = useState<number | null>(null);             // package id
    const [selling, setSelling] = useState(false);
    const [pick, setPick] = useState<Set<number>>(new Set());
    const [search, setSearch] = useState('');
    const [locFilter, setLocFilter] = useState('');
    const [paySale, setPaySale] = useState<PackageSale | null>(null);
    const [payments, setPayments] = useState<PackagePayment[]>([]);
    const [payForm, setPayForm] = useState({ amount: '', method: PAYMENT_METHODS[0], reference: '', date: '' });
    const [confirmState, setConfirmState] = useState<{ text: string; onOk: () => void; okLabel?: string; tone?: 'go' } | null>(null);
    // Bus notices (2.27.0): the bus whose message box is open, its text and its past notices.
    const [msgFor, setMsgFor] = useState<number | null>(null);
    const [msgText, setMsgText] = useState('');
    const [notices, setNotices] = useState<BusNotice[]>([]);

    const load = async () => {
        try {
            // The buses and packages are this page; attendees / fields / locations only name the passengers, so a
            // role that may not read them still gets its transport (passengers then show as «#id»).
            const [b, k, p, f, l] = await Promise.all([
                conferenceApi.getBuses(conferenceId),
                conferenceApi.getPackages(conferenceId),
                conferenceApi.getInscriptions(conferenceId).catch(() => []),
                conferenceApi.getFields(conferenceId).catch(() => []),
                conferenceApi.getLocations(conferenceId).catch(() => null),
            ]);
            setBuses(b || []); setPackages(k || []); setPeople(p || []); setFields(f || []); setLocations(l?.locations || []);
        } catch (e: any) {
            addToast(e?.message || 'Error', 'error');
        } finally {
            setLoading(false);
        }
    };
    useEffect(() => { setLoading(true); load(); }, [conferenceId]);

    const personById = useMemo(() => new Map(people.map((p: any) => [Number(p.id), p])), [people]);
    const nameOf = (id: number) => { const p = personById.get(Number(id)); return p ? displayName(p, fields as any) : `#${id}`; };
    const busById = useMemo(() => new Map(buses.map((b) => [b.id, b])), [buses]);
    const totals = useMemo(() => ({
        seats: buses.reduce((a, b) => a + (Number(b.capacity) || 0), 0),
        sold: buses.reduce((a, b) => a + (Number(b.sold) || 0), 0),
        revenue: packages.reduce((a, p) => a + (Number(p.revenue) || 0), 0),
        collected: packages.reduce((a, p) => a + (Number(p.collected) || 0), 0),
        sales: packages.reduce((a, p) => a + (Number(p.sold) || 0), 0),
    }), [buses, packages]);

    const run = async (fn: () => Promise<any>, ok?: string) => {
        setBusy(true);
        try { await fn(); if (ok) addToast(ok, 'success'); await load(); return true; }
        catch (e: any) { addToast(e?.message || 'Error', 'error'); return false; }
        finally { setBusy(false); }
    };

    // ── buses
    const openBus = (b?: Bus) => setBusForm(b ? {
        id: b.id, name: b.name || '', origin: b.origin || '', destination: b.destination || '',
        departure: String(b.departure || '').slice(0, 16).replace(' ', 'T'), capacity: String(b.capacity), notes: b.notes || '',
    } : { name: '', origin: '', destination: '', departure: '', capacity: '', notes: '' });
    const saveBus = async () => {
        const f = busForm;
        const data = { name: f.name, origin: f.origin, destination: f.destination, departure: f.departure || null, capacity: f.capacity, notes: f.notes };
        const ok = await run(() => f.id ? conferenceApi.updateBus(f.id, data) : conferenceApi.createBus(conferenceId, { ...data, price: 0 } as any),
            f.id ? tt('transport.bus.saved', 'Bus actualizado') : tt('transport.bus.created', 'Bus creado'));
        if (ok) setBusForm(null);
    };
    const deleteBus = (b: Bus) => setConfirmState({
        text: tt('transport.bus.confirm.delete2', '¿Eliminar el bus «{name}»? Sale también de los paquetes que aún no se han vendido.').replace('{name}', b.name),
        onOk: () => run(() => conferenceApi.deleteBus(b.id), tt('transport.bus.deleted', 'Bus eliminado')),
    });

    // ── boarding and bus notices (2.27.0)
    const deliveryToast = (r: NoticeResult) => {
        const d = r.delivery;
        if (!d) return;
        if (!d.network && d.subscribers > 0) {
            addToast(tt('transport.notice.nonet', 'Guardado, pero sin el permiso «Red» no se envían notificaciones: los pasajeros lo ven al abrir su página. Concédelo en Plugins › Conference Manager › Permisos.'), 'warning', 9000);
        } else if (d.subscribers === 0) {
            addToast(tt('transport.notice.none', 'Guardado. Nadie de este bus tiene los avisos activados: lo ven al abrir su página.'), 'info', 6000);
        } else {
            addToast(tt('transport.notice.sent', 'Avisados {sent} de {n} teléfonos.').replace('{sent}', String(d.sent)).replace('{n}', String(d.subscribers)), d.failed ? 'warning' : 'success', 6000);
        }
    };
    const notice = async (b: Bus, kind: 'boarding' | 'departed' | 'message' | 'reset', text?: string) => {
        if (busy) return false;
        setBusy(true);
        try {
            const r = await conferenceApi.busNotice(b.id, kind, text);
            setBuses(list => list.map(x => (x.id === b.id ? { ...x, ...r.bus } : x)));
            deliveryToast(r);
            if (kind === 'reset') addToast(tt('transport.notice.reset.done', 'El bus volvió a «Programado».'), 'success');
            return true;
        } catch (e: any) {
            addToast(e?.message || 'Error', 'error');
            return false;
        } finally {
            setBusy(false);
        }
    };
    const alertsLine = (b: Bus) => tt('transport.notice.alerts', '{n} de {total} pasajeros con avisos activos').replace('{n}', String(b.alerts || 0)).replace('{total}', String(Number(b.sold) || 0));
    const startBoarding = (b: Bus) => setConfirmState({
        text: `${tt('transport.notice.confirm.boarding', '¿Iniciar el embarque de «{name}»? Se avisa a sus pasajeros.').replace('{name}', b.name)} (${alertsLine(b)})`,
        okLabel: tt('transport.notice.boarding', 'Iniciar embarque'), tone: 'go',
        onOk: () => { notice(b, 'boarding'); },
    });
    const markDeparted = (b: Bus) => setConfirmState({
        text: `${tt('transport.notice.confirm.departed', '¿Marcar que «{name}» salió? Se avisa a sus pasajeros.').replace('{name}', b.name)} (${alertsLine(b)})`,
        okLabel: tt('transport.notice.departed', 'Marcar salida'), tone: 'go',
        onOk: () => { notice(b, 'departed'); },
    });
    const resetBus = (b: Bus) => setConfirmState({
        text: tt('transport.notice.confirm.reset', '¿Volver «{name}» a «Programado»? No se avisa a nadie.').replace('{name}', b.name),
        okLabel: tt('transport.notice.reset', 'Reiniciar'), tone: 'go',
        onOk: () => { notice(b, 'reset'); },
    });
    const openMessage = async (b: Bus) => {
        setMsgFor(b.id); setMsgText(''); setNotices([]);
        try { setNotices(await conferenceApi.getBusNotices(b.id)); } catch { /* the box still works */ }
    };
    const sendMessage = async () => {
        const b = buses.find(x => x.id === msgFor);
        if (!b || !msgText.trim()) return;
        if (await notice(b, 'message', msgText.trim())) { setMsgFor(null); setMsgText(''); }
    };
    const NOTICE_LABEL: Record<string, string> = {
        boarding: tt('transport.notice.kind.boarding', 'Inició el embarque'),
        departed: tt('transport.notice.kind.departed', 'Marcó la salida'),
        message: tt('transport.notice.kind.message', 'Mensaje'),
    };

    // ── packages
    const openPackage = (p?: TransportPackage) => setPkgForm(p ? {
        id: p.id, name: p.name, price: String(p.price ?? ''), notes: p.notes || '', bus_ids: new Set(p.buses.map(b => b.id)),
        originalPrice: p.price, sold: p.sold, reprice: false,
    } : { name: '', price: '', notes: '', bus_ids: new Set<number>(), sold: 0, reprice: false });
    const savePackage = async () => {
        const f = pkgForm;
        const data: any = { name: f.name, price: f.price === '' ? 0 : f.price, notes: f.notes, bus_ids: [...f.bus_ids] };
        if (f.id && f.reprice) data.reprice_sales = true;
        const ok = await run(() => f.id ? conferenceApi.updatePackage(f.id, data) : conferenceApi.createPackage(conferenceId, data),
            f.id ? tt('transport.pkg.saved', 'Paquete actualizado') : tt('transport.pkg.created', 'Paquete creado'));
        if (ok) setPkgForm(null);
    };
    const deletePackage = (p: TransportPackage) => setConfirmState({
        text: tt('transport.pkg.confirm.delete', '¿Eliminar el paquete «{name}»? Quienes lo tienen sin pagos lo pierden y sus puestos quedan libres.').replace('{name}', p.name),
        onOk: () => run(() => conferenceApi.deletePackage(p.id), tt('transport.pkg.deleted', 'Paquete eliminado')),
    });

    // ── selling a package
    const currentPkg = packages.find(p => p.id === salesFor) || null;
    const pkgBusIds = useMemo(() => new Set((currentPkg?.buses || []).map(b => b.id)), [currentPkg]);
    const has = useMemo(() => new Set((currentPkg?.sales || []).map(s => Number(s.inscription_id))), [currentPkg]);
    // People who already sit on one of this package's buses (through another package) cannot buy it.
    const seatedElsewhere = useMemo(() => {
        const out = new Map<number, string>();
        for (const b of buses) if (pkgBusIds.has(b.id)) for (const s of b.passengers || []) if (!has.has(Number(s.inscription_id))) out.set(Number(s.inscription_id), s.package_name || b.name);
        return out;
    }, [buses, pkgBusIds, has]);
    const free = useMemo(() => {
        if (!currentPkg || !currentPkg.buses.length) return 0;
        return Math.min(...currentPkg.buses.map(b => { const bus = busById.get(b.id); return bus ? Math.max(0, Number(bus.capacity) - (Number(bus.sold) || 0)) : 0; }));
    }, [currentPkg, busById]);
    const candidates = useMemo(() => {
        const q = search.trim().toLowerCase();
        return people.filter((p: any) => p.status !== 'cancelled' && !has.has(Number(p.id))
            && (!locFilter || String(p.location_id) === locFilter)
            && (!q || [displayName(p, fields as any), p.reg_code, p.location, p.document_number].some(v => String(v || '').toLowerCase().includes(q))));
    }, [people, has, search, locFilter, fields]);
    const togglePick = (id: number) => setPick(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
    const openSales = (p: TransportPackage, sell = false) => { setSalesFor(p.id); setSelling(sell); setPick(new Set()); setSearch(''); setLocFilter(''); };
    const sell = async () => {
        if (!currentPkg || !pick.size) return;
        const ok = await run(() => conferenceApi.sellPackage(currentPkg.id, [...pick]), tt('transport.pkg.sold', '{n} paquetes vendidos').replace('{n}', String(pick.size)));
        if (ok) { setPick(new Set()); setSelling(false); }
    };
    const removeSale = (s: PackageSale) => setConfirmState({
        text: tt('transport.pkg.confirm.remove', '¿Quitarle el paquete a {name}? Sus puestos quedan libres.').replace('{name}', nameOf(s.inscription_id)),
        onOk: () => run(() => conferenceApi.removePackageSale(s.id), tt('transport.pkg.removed', 'Paquete quitado')),
    });

    // ── payments of a sale
    const owed = (s: PackageSale) => Math.max(0, Math.round((Number(s.price) - Number(s.amount_paid)) * 100) / 100);
    const openPayments = async (s: PackageSale) => {
        setPaySale(s);
        setPayForm({ amount: String(owed(s)), method: PAYMENT_METHODS[0], reference: '', date: '' });
        try { setPayments(await conferenceApi.getSalePayments(s.id)); } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
    };
    const refreshSale = async (saleId: number) => {
        const k = await conferenceApi.getPackages(conferenceId);
        setPackages(k || []);
        const s = (k || []).flatMap(p => p.sales || []).find(x => x.id === saleId) || null;
        setPaySale(s);
        setPayments(await conferenceApi.getSalePayments(saleId));
        if (s) setPayForm(f => ({ ...f, amount: String(owed(s)), reference: '' }));
        setBuses(await conferenceApi.getBuses(conferenceId));
    };
    const addPayment = async () => {
        if (!paySale) return;
        setBusy(true);
        try {
            await conferenceApi.addSalePayment(paySale.id, { amount: Number(payForm.amount), method: payForm.method, reference: payForm.reference || undefined, date: payForm.date || undefined });
            addToast(tt('transport.payment.added', 'Pago registrado'), 'success');
            await refreshSale(paySale.id);
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
        finally { setBusy(false); }
    };
    const deletePayment = (p: PackagePayment) => setConfirmState({
        text: tt('transport.payment.confirm.delete', '¿Eliminar el pago de {amount}?').replace('{amount}', money(p.amount)),
        onOk: async () => {
            setBusy(true);
            try { await conferenceApi.deletePackagePayment(p.id); addToast(tt('transport.payment.deleted', 'Pago eliminado'), 'success'); if (paySale) await refreshSale(paySale.id); }
            catch (e: any) { addToast(e?.message || 'Error', 'error'); }
            finally { setBusy(false); }
        },
    });

    // ── Excel
    const excel = (busId: number | null) => {
        try {
            const built = buildBusManifest({ buses: buses as any, people: people as any, fields: fields as any, onlyBusId: busId, packages: packages as any });
            const sheets = perms.can('inscriptions') ? built : withoutColumn(built, 'Código');
            const name = busId != null ? 'bus-' + String(buses.find(b => b.id === busId)?.name || busId).toLowerCase() : 'transporte';
            downloadXlsx(buildXlsx(sheets), exportFilename(name, slug));
        } catch (e: any) { addToast(e?.message || 'Error', 'error'); }
    };

    if (loading) {
        return (
            <div className="text-center py-20">
                <div className="inline-block w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-400 text-xs font-bold uppercase tracking-widest">{tt('loading', 'Cargando…')}</p>
            </div>
        );
    }

    const currentBus = buses.find(b => b.id === passengersFor) || null;
    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            <ReadOnlyNotice section="transport" />
            {boarding != null && buses.length > 0 && <BoardingScanner buses={buses} busId={boarding} onClose={() => setBoarding(null)} />}
            {/* Header */}
            <div className="relative overflow-hidden bg-white rounded-3xl p-8 border border-gray-100 shadow-xl shadow-gray-100/50">
                <div className="absolute top-0 right-0 -mr-16 -mt-16 w-64 h-64 bg-sky-50/60 rounded-full blur-3xl pointer-events-none"></div>
                <div className="relative flex flex-wrap items-center justify-between gap-6">
                    <div className="min-w-0" style={{ flex: '1 1 18rem' }}>
                        <div className="flex items-center gap-3 mb-3">
                            <div className="w-10 h-10 shrink-0 rounded-xl bg-sky-600 flex items-center justify-center text-white shadow-lg shadow-sky-200"><i className="fa-solid fa-bus"></i></div>
                            <span className="text-[10px] font-bold text-sky-600 uppercase tracking-[0.2em]">{tt('transport', 'Transporte')}</span>
                        </div>
                        <h2 className="text-3xl font-black text-gray-900 italic tracking-tighter">{tt('transport.title2', 'Buses y paquetes')}</h2>
                        <p className="text-xs text-gray-500 mt-1 max-w-xl">{tt('transport.subtitle2', 'Se venden paquetes de buses, aparte de la cuota de participación: cada paquete tiene su precio, y cada venta sus pagos y su estado.')}</p>
                        <div className="flex flex-wrap gap-3 mt-4">
                            {[
                                [tt('transport.stat.buses', 'Buses'), String(buses.length)],
                                [tt('transport.stat.seats', 'Puestos vendidos'), `${totals.sold}/${totals.seats}`],
                                [tt('transport.stat.packages', 'Paquetes vendidos'), String(totals.sales)],
                                [tt('transport.stat.sold', 'Vendido'), money(totals.revenue)],
                                [tt('transport.stat.collected', 'Recaudado'), money(totals.collected)],
                                [tt('transport.stat.pending', 'Por cobrar'), money(totals.revenue - totals.collected)],
                            ].map(([label, value]) => (
                                <div key={label} className="bg-gray-50/80 px-4 py-2.5 rounded-2xl border border-gray-100">
                                    <div className="text-sm font-black text-gray-900 leading-none whitespace-nowrap">{value}</div>
                                    <div className="text-[8px] font-black text-gray-400 uppercase tracking-widest mt-1">{label}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {buses.length > 0 && <button type="button" onClick={() => setBoarding(buses[0].id)} data-boarding-open="" className="px-6 py-4 rounded-2xl bg-gray-900 text-white hover:bg-sky-700 font-black text-[10px] uppercase tracking-widest transition-all">
                            <i className="fa-solid fa-qrcode mr-1.5" aria-hidden="true"></i>{tt('transport.board.title', 'Verificar abordaje')}
                        </button>}
                        {canExcel && <button onClick={() => excel(null)} disabled={!buses.length} className="px-6 py-4 rounded-2xl bg-white border-2 border-gray-100 text-emerald-700 hover:border-emerald-500 font-black text-[10px] uppercase tracking-widest transition-all disabled:opacity-50">
                            <i className="fa-solid fa-file-excel mr-1.5"></i>{tt('transport.excel', 'Excel de transporte')}
                        </button>}
                    </div>
                </div>
            </div>

            {/* Packages */}
            <section className="space-y-4" data-packages="">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-xl font-black text-gray-900 italic tracking-tighter"><i className="fa-solid fa-box-open text-sky-600 mr-2" aria-hidden="true"></i>{tt('transport.pkg.title', 'Paquetes')}</h3>
                    {canManage && <button onClick={() => openPackage()} disabled={!buses.length} data-package-new="" className="px-6 py-3 rounded-2xl bg-sky-600 text-white hover:bg-sky-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-sky-500/30 disabled:opacity-50">
                        <i className="fa-solid fa-plus mr-1.5"></i>{tt('transport.pkg.new', 'Nuevo paquete')}
                    </button>}
                </div>
                {packages.length === 0 ? (
                    <div className="flex flex-col justify-center items-center py-12 bg-gray-50/50 border-2 border-dashed border-gray-100 rounded-3xl text-center px-6">
                        <p className="text-gray-600 font-bold">{tt('transport.pkg.empty', 'Aún no hay paquetes.')}</p>
                        {canManage && <p className="text-xs text-gray-400 mt-1">{buses.length ? tt('transport.pkg.empty.hint', 'Un paquete reúne uno o varios buses (por ejemplo ida y regreso) con un solo precio: es lo que se vende.') : tt('transport.pkg.empty.nobus', 'Primero crea los buses; luego arma los paquetes con ellos.')}</p>}
                    </div>
                ) : (
                    <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 22rem), 1fr))' }}>
                        {packages.map(p => (
                            <div key={p.id} className="bg-white p-6 rounded-[28px] border-2 border-gray-50 shadow-sm hover:border-sky-200 hover:shadow-xl transition-all" data-package={p.id}>
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div className="min-w-0" style={{ flex: '1 1 12rem' }}>
                                        <h4 className="text-xl font-black text-gray-900 italic tracking-tighter" style={{ overflowWrap: 'anywhere' }}>{p.name}</h4>
                                        <div className="text-lg font-black text-sky-700">{money(p.price)}</div>
                                    </div>
                                    {canManage && <div className="flex gap-1.5 shrink-0">
                                        <button onClick={() => openPackage(p)} title={tt('edit', 'Editar')} aria-label={tt('edit', 'Editar')} className={`${iconBtn} text-gray-400 hover:bg-blue-600 hover:text-white`}><i className="fa-solid fa-pen text-xs"></i></button>
                                        <button onClick={() => deletePackage(p)} title={tt('delete', 'Eliminar')} aria-label={tt('delete', 'Eliminar')} className={`${iconBtn} text-gray-400 hover:bg-rose-600 hover:text-white`}><i className="fa-solid fa-trash-can text-xs"></i></button>
                                    </div>}
                                </div>
                                <div className="flex flex-wrap gap-1.5 mt-3">
                                    {p.buses.map(b => <span key={b.id} className="px-2.5 py-1 rounded-lg bg-sky-50 text-sky-700 border border-sky-100 text-[10px] font-black uppercase tracking-widest"><i className="fa-solid fa-bus-simple mr-1" aria-hidden="true"></i>{b.name}</span>)}
                                </div>
                                {p.notes && <p className="text-[11px] text-gray-500 mt-2">{p.notes}</p>}
                                <div className="grid gap-2 mt-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(6rem, 1fr))' }}>
                                    <Stat label={tt('transport.pkg.sales', 'Vendidos')} value={String(p.sold)} />
                                    <Stat label={tt('transport.stat.collected', 'Recaudado')} value={money(p.collected)} cls="text-emerald-600" />
                                    <Stat label={tt('transport.stat.pending', 'Por cobrar')} value={money(p.revenue - p.collected)} cls="text-rose-600" />
                                </div>
                                <div className="flex flex-wrap gap-2 mt-4">
                                    <button onClick={() => openSales(p)} className="flex-1 min-w-[8rem] px-4 py-3 rounded-2xl bg-gray-900 text-white hover:bg-sky-600 font-black text-[10px] uppercase tracking-widest" data-package-sales={p.id}>
                                        <i className="fa-solid fa-users mr-1.5"></i>{tt('transport.pkg.buyers', 'Compradores')} ({p.sold})
                                    </button>
                                    {canManage && <button onClick={() => openSales(p, true)} className="flex-1 min-w-[8rem] px-4 py-3 rounded-2xl bg-sky-600 text-white hover:bg-sky-700 font-black text-[10px] uppercase tracking-widest" data-package-sell={p.id}>
                                        <i className="fa-solid fa-cart-plus mr-1.5"></i>{tt('transport.pkg.sell', 'Vender')}
                                    </button>}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {/* Buses */}
            <section className="space-y-4" data-buses="">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-xl font-black text-gray-900 italic tracking-tighter"><i className="fa-solid fa-bus text-sky-600 mr-2" aria-hidden="true"></i>{tt('transport.buses', 'Buses')}</h3>
                    {canManage && <button onClick={() => openBus()} className="px-6 py-3 rounded-2xl bg-white border-2 border-gray-100 text-sky-700 hover:border-sky-500 font-black text-[10px] uppercase tracking-widest">
                        <i className="fa-solid fa-plus mr-1.5"></i>{tt('transport.bus.new', 'Nuevo bus')}
                    </button>}
                </div>
                {buses.length === 0 ? (
                    <div className="flex flex-col justify-center items-center py-12 bg-gray-50/50 border-2 border-dashed border-gray-100 rounded-3xl text-center px-6">
                        <p className="text-gray-600 font-bold">{tt('transport.empty', 'Aún no hay buses.')}</p>
                        {canManage && <p className="text-xs text-gray-400 mt-1">{tt('transport.empty.hint2', 'Crea cada bus con su trayecto, salida y capacidad.')}</p>}
                    </div>
                ) : (
                    <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 22rem), 1fr))' }}>
                        {buses.map(b => {
                            const sold = Number(b.sold) || 0, cap = Number(b.capacity) || 0;
                            const pct = cap ? Math.min(100, Math.round((sold / cap) * 100)) : 0;
                            const route = [b.origin, b.destination].filter(Boolean).join(' → ');
                            return (
                                <div key={b.id} className="bg-white p-6 rounded-[28px] border-2 border-gray-50 shadow-sm hover:border-sky-200 hover:shadow-xl transition-all">
                                    <div className="flex flex-wrap items-start justify-between gap-4">
                                        <div className="flex items-center gap-4 min-w-0" style={{ flex: '1 1 12rem' }}>
                                            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-sky-50 to-blue-50 text-sky-600 flex items-center justify-center text-lg shadow-inner shrink-0"><i className="fa-solid fa-bus-simple"></i></div>
                                            <div className="min-w-0">
                                                <h4 className="text-xl font-black text-gray-900 italic tracking-tighter truncate">{b.name}</h4>
                                                <div className="text-xs font-bold text-gray-500 truncate">{route || tt('transport.route.none', 'Sin trayecto')}</div>
                                                {b.departure && <div className="text-[10px] font-black text-sky-600 uppercase tracking-widest mt-0.5"><i className="fa-regular fa-clock mr-1"></i>{fmtWhen(b.departure)}</div>}
                                            </div>
                                        </div>
                                        <div className="flex gap-1.5 shrink-0">
                                            <button onClick={() => setBoarding(b.id)} title={tt('transport.board.title', 'Verificar abordaje')} aria-label={tt('transport.board.title', 'Verificar abordaje')} data-boarding-bus-open={b.id} className={`${iconBtn} text-sky-700 hover:bg-sky-600 hover:text-white`}><i className="fa-solid fa-qrcode text-xs"></i></button>
                                            {canExcel && <button onClick={() => excel(b.id)} title={tt('transport.bus.excel', 'Lista de pasajeros (Excel)')} className={`${iconBtn} text-emerald-600 hover:bg-emerald-600 hover:text-white`}><i className="fa-solid fa-file-excel text-xs"></i></button>}
                                            {canManage && <button onClick={() => openBus(b)} title={tt('edit', 'Editar')} className={`${iconBtn} text-gray-400 hover:bg-blue-600 hover:text-white`}><i className="fa-solid fa-pen text-xs"></i></button>}
                                            {canManage && <button onClick={() => deleteBus(b)} title={tt('delete', 'Eliminar')} className={`${iconBtn} text-gray-400 hover:bg-rose-600 hover:text-white`}><i className="fa-solid fa-trash-can text-xs"></i></button>}
                                        </div>
                                    </div>
                                    <div className="mt-4">
                                        <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">
                                            <span>{tt('transport.seats', 'Puestos')}: {sold}/{cap}</span>
                                            <span>{Math.max(0, cap - sold)} {tt('transport.free', 'libres')}</span>
                                        </div>
                                        <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
                                            <div className={`h-full rounded-full ${pct >= 100 ? 'bg-rose-500' : pct >= 80 ? 'bg-amber-400' : 'bg-sky-500'}`} style={{ width: `${pct}%` }}></div>
                                        </div>
                                        {b.notes && <p className="text-[11px] text-gray-500 mt-3"><i className="fa-solid fa-note-sticky mr-1 text-gray-300"></i>{b.notes}</p>}
                                        <button onClick={() => setPassengersFor(b.id)} className="mt-4 w-full px-4 py-3 rounded-2xl bg-gray-50 text-gray-800 hover:bg-gray-900 hover:text-white font-black text-[10px] uppercase tracking-widest transition-all">
                                            <i className="fa-solid fa-users mr-1.5"></i>{tt('transport.passengers', 'Pasajeros')} ({sold})
                                        </button>
                                        {/* Boarding (2.27.0): its state, who gets the notices, and the team's buttons. */}
                                        <div className={`mt-3 rounded-2xl border-2 p-3 space-y-2.5 ${b.status === 'boarding' ? 'border-amber-200 bg-amber-50' : b.status === 'departed' ? 'border-gray-200 bg-gray-50' : 'border-gray-100'}`} data-bus-boarding={b.status || 'scheduled'}>
                                            <div className="flex flex-wrap items-center justify-between gap-2">
                                                {b.status === 'boarding' ? (
                                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500 text-white px-3 py-1 text-[10px] font-black uppercase tracking-widest"><span className="w-2 h-2 rounded-full bg-white animate-pulse" aria-hidden="true"></span>{tt('transport.notice.state.boarding', 'Embarcando')}{b.boarding_at ? ` · ${fmtClock(b.boarding_at)}` : ''}</span>
                                                ) : b.status === 'departed' ? (
                                                    <span className="rounded-full bg-gray-800 text-white px-3 py-1 text-[10px] font-black uppercase tracking-widest">{tt('transport.notice.state.departed', 'Salió')}{b.departed_at ? ` · ${fmtClock(b.departed_at)}` : ''}</span>
                                                ) : (
                                                    <span className="rounded-full bg-gray-100 text-gray-600 px-3 py-1 text-[10px] font-black uppercase tracking-widest">{tt('transport.notice.state.scheduled', 'Programado')}</span>
                                                )}
                                                <span className="text-[10px] font-bold text-gray-500" title={tt('transport.notice.alerts.hint', 'Pasajeros que activaron los avisos en «Mi inscripción» (el QR de su escarapela).')}><i className="fa-solid fa-bell mr-1 text-gray-400" aria-hidden="true"></i>{alertsLine(b)}</span>
                                            </div>
                                            {canManage && (
                                                <div className="flex flex-wrap gap-2">
                                                    {(b.status || 'scheduled') === 'scheduled' && <button onClick={() => startBoarding(b)} disabled={busy} data-bus-notice="boarding" className="flex-1 min-w-[9rem] min-h-[40px] px-3 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-black text-[10px] uppercase tracking-widest disabled:opacity-60"><i className="fa-solid fa-bullhorn mr-1.5" aria-hidden="true"></i>{tt('transport.notice.boarding', 'Iniciar embarque')}</button>}
                                                    {b.status === 'boarding' && <button onClick={() => markDeparted(b)} disabled={busy} data-bus-notice="departed" className="flex-1 min-w-[9rem] min-h-[40px] px-3 rounded-xl bg-gray-900 hover:bg-black text-white font-black text-[10px] uppercase tracking-widest disabled:opacity-60"><i className="fa-solid fa-road mr-1.5" aria-hidden="true"></i>{tt('transport.notice.departed', 'Marcar salida')}</button>}
                                                    <button onClick={() => openMessage(b)} disabled={busy} data-bus-notice="message" className="flex-1 min-w-[7rem] min-h-[40px] px-3 rounded-xl bg-white border-2 border-gray-200 hover:border-sky-400 text-gray-800 font-black text-[10px] uppercase tracking-widest disabled:opacity-60"><i className="fa-solid fa-comment mr-1.5" aria-hidden="true"></i>{tt('transport.notice.message', 'Mensaje')}</button>
                                                    {(b.status === 'boarding' || b.status === 'departed') && <button onClick={() => resetBus(b)} disabled={busy} title={tt('transport.notice.reset', 'Reiniciar')} aria-label={tt('transport.notice.reset', 'Reiniciar')} data-bus-notice="reset" className={`${iconBtn} min-h-[40px] w-10 text-gray-500 hover:bg-gray-700 hover:text-white`}><i className="fa-solid fa-rotate-left text-xs" aria-hidden="true"></i></button>}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>

            {/* Bus form */}
            {busForm && canManage && (
                <Modal title={busForm.id ? tt('transport.bus.edit', 'Editar bus') : tt('transport.bus.new', 'Nuevo bus')} subtitle={tt('transport.bus.form.subtitle2', 'Trayecto, salida y capacidad')} onClose={() => setBusForm(null)}
                    footer={<>
                        <button onClick={() => setBusForm(null)} className="px-6 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{tt('cancel', 'Cancelar')}</button>
                        <button onClick={saveBus} disabled={busy || !busForm.name.trim() || !busForm.capacity} className="px-8 py-3 bg-sky-600 text-white rounded-2xl hover:bg-sky-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-sky-500/30 disabled:opacity-50">{tt('save', 'Guardar')}</button>
                    </>}>
                    <div className="space-y-1.5"><label htmlFor="bus-name" className={labelCls}>{tt('transport.bus.name', 'Nombre del bus')} *</label>
                        <input id="bus-name" className={inputCls} value={busForm.name} onChange={e => setBusForm({ ...busForm, name: e.target.value })} placeholder="Ej. Bus 1 — Ida" autoFocus={canAutoFocus()} /></div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5"><label htmlFor="bus-origin" className={labelCls}>{tt('transport.origin', 'Origen')}</label>
                            <input id="bus-origin" className={inputCls} value={busForm.origin} onChange={e => setBusForm({ ...busForm, origin: e.target.value })} /></div>
                        <div className="space-y-1.5"><label htmlFor="bus-destination" className={labelCls}>{tt('transport.destination', 'Destino')}</label>
                            <input id="bus-destination" className={inputCls} value={busForm.destination} onChange={e => setBusForm({ ...busForm, destination: e.target.value })} /></div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5"><label htmlFor="bus-departure" className={labelCls}>{tt('transport.departure', 'Salida')}</label>
                            <DateField id="bus-departure" withTime value={busForm.departure} onChange={v => setBusForm({ ...busForm, departure: v })} /></div>
                        <div className="space-y-1.5"><label htmlFor="bus-capacity" className={labelCls}>{tt('transport.capacity', 'Capacidad (puestos)')} *</label>
                            <input id="bus-capacity" type="number" min={1} step={1} className={inputCls} value={busForm.capacity} onChange={e => setBusForm({ ...busForm, capacity: e.target.value })} /></div>
                    </div>
                    <div className="space-y-1.5"><label htmlFor="bus-notes" className={labelCls}>{tt('transport.notes', 'Notas')}</label>
                        <textarea id="bus-notes" rows={2} className={inputCls + ' resize-none'} value={busForm.notes} onChange={e => setBusForm({ ...busForm, notes: e.target.value })} /></div>
                </Modal>
            )}

            {/* Package form */}
            {pkgForm && canManage && (
                <Modal title={pkgForm.id ? tt('transport.pkg.edit', 'Editar paquete') : tt('transport.pkg.new', 'Nuevo paquete')} subtitle={tt('transport.pkg.form.subtitle', 'Sus buses y su precio')} onClose={() => setPkgForm(null)}
                    footer={<>
                        <button onClick={() => setPkgForm(null)} className="px-6 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{tt('cancel', 'Cancelar')}</button>
                        <button onClick={savePackage} disabled={busy || !pkgForm.name.trim() || !pkgForm.bus_ids.size} data-package-save="" className="px-8 py-3 bg-sky-600 text-white rounded-2xl hover:bg-sky-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-sky-500/30 disabled:opacity-50">{tt('save', 'Guardar')}</button>
                    </>}>
                    <div className="space-y-1.5"><label htmlFor="pkg-name" className={labelCls}>{tt('transport.pkg.name', 'Nombre del paquete')} *</label>
                        <input id="pkg-name" className={inputCls} value={pkgForm.name} onChange={e => setPkgForm({ ...pkgForm, name: e.target.value })} placeholder={tt('transport.pkg.name.ph', 'Ej. Ida y regreso')} autoFocus={canAutoFocus()} /></div>
                    <div className="space-y-1.5"><label htmlFor="pkg-price" className={labelCls}>{tt('transport.pkg.price', 'Precio del paquete')}</label>
                        <input id="pkg-price" type="number" min={0} step="0.01" className={inputCls} value={pkgForm.price} onChange={e => setPkgForm({ ...pkgForm, price: e.target.value })} /></div>
                    {pkgForm.id && pkgForm.sold > 0 && String(pkgForm.price) !== String(pkgForm.originalPrice) && (
                        <label className="flex items-start gap-3 px-4 py-3 rounded-2xl border-2 border-amber-100 bg-amber-50/50 cursor-pointer">
                            <input type="checkbox" checked={pkgForm.reprice} onChange={e => setPkgForm({ ...pkgForm, reprice: e.target.checked })} className="accent-amber-600 w-4 h-4 mt-0.5" />
                            <span className="text-xs text-amber-900"><b>{tt('transport.pkg.reprice', 'Aplicar el nuevo precio a los paquetes ya vendidos')}</b><br />{tt('transport.reprice.help', 'Si no, el nuevo precio solo aplica a las próximas ventas.')}</span>
                        </label>
                    )}
                    <fieldset className="space-y-2">
                        <legend className={labelCls}>{tt('transport.pkg.buses', 'Buses del paquete')} *</legend>
                        {pkgForm.id && pkgForm.sold > 0 && <p className="text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">{tt('transport.pkg.locked', 'Ya se vendió: sus buses no pueden cambiar. Para otra combinación crea otro paquete.')}</p>}
                        <div className="rounded-2xl border border-gray-100 divide-y divide-gray-50 max-h-64 overflow-y-auto">
                            {buses.map(b => (
                                <label key={b.id} className={`flex items-center gap-3 px-4 py-2.5 ${pkgForm.id && pkgForm.sold > 0 ? 'opacity-60' : 'hover:bg-sky-50/50 cursor-pointer'}`}>
                                    <input type="checkbox" className="accent-sky-600 w-4 h-4" checked={pkgForm.bus_ids.has(b.id)} disabled={!!(pkgForm.id && pkgForm.sold > 0)}
                                        onChange={() => setPkgForm(f => { const n = new Set(f.bus_ids); n.has(b.id) ? n.delete(b.id) : n.add(b.id); return { ...f, bus_ids: n }; })} />
                                    <span className="flex-1 min-w-0">
                                        <span className="block text-sm font-bold text-gray-800 truncate">{b.name}</span>
                                        <span className="block text-[10px] text-gray-400 font-bold uppercase tracking-widest">{[[b.origin, b.destination].filter(Boolean).join(' → '), b.departure ? fmtWhen(b.departure) : '', `${Number(b.sold) || 0}/${b.capacity}`].filter(Boolean).join(' · ')}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>
                    <div className="space-y-1.5"><label htmlFor="pkg-notes" className={labelCls}>{tt('transport.notes', 'Notas')}</label>
                        <textarea id="pkg-notes" rows={2} className={inputCls + ' resize-none'} value={pkgForm.notes} onChange={e => setPkgForm({ ...pkgForm, notes: e.target.value })} /></div>
                </Modal>
            )}

            {/* Buyers of a package / selling it */}
            {currentPkg && (
                <Modal wide title={currentPkg.name} subtitle={`${currentPkg.buses.map(b => b.name).join(' + ')} · ${money(currentPkg.price)}`} onClose={() => setSalesFor(null)}
                    footer={!canManage ? null : selling ? <>
                        <span className="mr-auto text-xs font-bold text-gray-500 self-center">{tt('transport.add.selected', '{n} seleccionados · {free} puestos libres').replace('{n}', String(pick.size)).replace('{free}', String(free))}</span>
                        <button onClick={() => { setSelling(false); setPick(new Set()); }} className="px-6 py-3 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{tt('cancel', 'Cancelar')}</button>
                        <button onClick={sell} disabled={busy || !pick.size || pick.size > free} data-package-sell-confirm="" className="px-8 py-3 bg-sky-600 text-white rounded-2xl hover:bg-sky-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-sky-500/30 disabled:opacity-50">{tt('transport.pkg.sell.confirm', 'Vender paquetes')}</button>
                    </> : <>
                        <button onClick={() => setSelling(true)} disabled={free <= 0} className="px-8 py-3 bg-sky-600 text-white rounded-2xl hover:bg-sky-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-sky-500/30 disabled:opacity-50"><i className="fa-solid fa-cart-plus mr-1.5"></i>{free <= 0 ? tt('transport.pkg.full', 'Sin puestos libres') : tt('transport.pkg.sell', 'Vender')}</button>
                    </>}>
                    {selling && canManage ? (
                        <>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <input className={inputCls} value={search} onChange={e => setSearch(e.target.value)} placeholder={tt('transport.add.search', 'Buscar por nombre, código o documento…')} aria-label={tt('transport.add.search', 'Buscar')} />
                                <Select className={inputCls} value={locFilter} onChange={e => setLocFilter(e.target.value)} aria-label={tt('excel.filter.location', 'Localidad')}>
                                    <option value="">{tt('excel.filter.all', 'Todas')}</option>
                                    {locations.map(l => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
                                </Select>
                            </div>
                            {pick.size > free && <p className="text-xs font-bold text-rose-600">{tt('transport.add.too.many', 'Solo quedan {free} puestos.').replace('{free}', String(free))}</p>}
                            <div className="rounded-2xl border border-gray-100 divide-y divide-gray-50 max-h-96 overflow-y-auto">
                                {candidates.length === 0 && <div className="px-4 py-8 text-center text-xs text-gray-400 italic">{tt('transport.add.none', 'No hay participantes disponibles.')}</div>}
                                {candidates.slice(0, 400).map((p: any) => {
                                    const clash = seatedElsewhere.get(Number(p.id));
                                    return (
                                        <label key={p.id} className={`flex items-center gap-3 px-4 py-2.5 ${clash ? 'opacity-60' : 'hover:bg-sky-50/50 cursor-pointer'}`}>
                                            <input type="checkbox" checked={pick.has(p.id)} disabled={!!clash} onChange={() => togglePick(p.id)} className="accent-sky-600 w-4 h-4" aria-label={displayName(p, fields as any)} />
                                            <span className="flex-1 min-w-0">
                                                <span className="block text-sm font-bold text-gray-800 truncate">{displayName(p, fields as any)}</span>
                                                <span className="block text-[10px] text-gray-400 font-bold uppercase tracking-widest">{p.location || '—'}{p.reg_code ? ` · ${p.reg_code}` : ''}</span>
                                                {clash && <span className="block text-[10px] font-bold text-amber-700">{tt('transport.pkg.clash', 'Ya va en uno de estos buses ({name})').replace('{name}', clash)}</span>}
                                            </span>
                                        </label>
                                    );
                                })}
                                {candidates.length > 400 && <div className="px-4 py-3 text-center text-[11px] text-gray-400">{tt('board.showing', 'Mostrando {n} de {total}').replace('{n}', '400').replace('{total}', String(candidates.length))}</div>}
                            </div>
                        </>
                    ) : (
                        <div className="rounded-2xl border border-gray-100 divide-y divide-gray-50 overflow-x-auto">
                            {currentPkg.sales.length === 0 && <div className="px-4 py-10 text-center text-xs text-gray-400 italic">{tt('transport.pkg.nobuyers', 'Nadie ha comprado este paquete todavía.')}</div>}
                            {currentPkg.sales.map(s => {
                                const meta = PAY_META[s.payment_status] || PAY_META.unpaid;
                                const p: any = personById.get(Number(s.inscription_id));
                                return (
                                    <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-sale={s.id}>
                                        <div className="flex-1 min-w-[10rem]">
                                            <div className="text-sm font-bold text-gray-800">{nameOf(s.inscription_id)}</div>
                                            <div className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{p?.location || '—'}{p?.reg_code ? ` · ${p.reg_code}` : ''}</div>
                                        </div>
                                        <div className="text-right">
                                            <div className="text-xs font-black text-gray-700">{money(s.amount_paid)} / {money(s.price)}</div>
                                            <span className={`inline-block mt-0.5 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border ${meta.cls}`}>{tt(meta.key, meta.fallback)}</span>
                                        </div>
                                        <button onClick={() => openPayments(s)} title={tt('transport.pkg.payments', 'Pagos del paquete')} aria-label={tt('transport.pkg.payments', 'Pagos del paquete')} className={`${iconBtn} text-gray-400 hover:bg-emerald-600 hover:text-white`}><i className="fa-solid fa-money-bill-wave text-xs"></i></button>
                                        {canManage && <button onClick={() => removeSale(s)} title={tt('transport.pkg.remove', 'Quitar el paquete')} aria-label={tt('transport.pkg.remove', 'Quitar el paquete')} className={`${iconBtn} text-gray-400 hover:bg-rose-600 hover:text-white`}><i className="fa-solid fa-user-minus text-xs"></i></button>}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </Modal>
            )}

            {/* Passengers of a bus (read only: seats come from packages) */}
            {currentBus && (
                <Modal wide title={currentBus.name} subtitle={`${tt('transport.passengers', 'Pasajeros')} · ${Number(currentBus.sold) || 0}/${currentBus.capacity}`} onClose={() => setPassengersFor(null)}>
                    <div className="rounded-2xl border border-gray-100 divide-y divide-gray-50 overflow-x-auto">
                        {(currentBus.passengers || []).length === 0 && <div className="px-4 py-10 text-center text-xs text-gray-400 italic">{tt('transport.passengers.none2', 'Nadie va en este bus todavía: vende un paquete que lo incluya.')}</div>}
                        {(currentBus.passengers || []).map(tk => {
                            const meta = PAY_META[tk.payment_status] || PAY_META.unpaid;
                            const p: any = personById.get(Number(tk.inscription_id));
                            return (
                                <div key={tk.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                                    <div className="flex-1 min-w-[10rem]">
                                        <div className="text-sm font-bold text-gray-800">{nameOf(tk.inscription_id)}</div>
                                        <div className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">{p?.location || '—'}{p?.reg_code ? ` · ${p.reg_code}` : ''}</div>
                                    </div>
                                    {tk.package_name && <span className="px-2.5 py-1 rounded-lg bg-sky-50 text-sky-700 border border-sky-100 text-[10px] font-black uppercase tracking-widest"><i className="fa-solid fa-box-open mr-1" aria-hidden="true"></i>{tk.package_name}</span>}
                                    <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border ${meta.cls}`}>{tt(meta.key, meta.fallback)}</span>
                                </div>
                            );
                        })}
                    </div>
                </Modal>
            )}

            {/* Payments of a sale */}
            {paySale && (
                <Modal title={tt('transport.pkg.payments', 'Pagos del paquete')} subtitle={`${nameOf(paySale.inscription_id)} · ${packages.find(p => p.id === paySale.package_id)?.name || ''}`} onClose={() => setPaySale(null)}>
                    <div className="grid grid-cols-3 gap-2 text-center">
                        {[[tt('transport.pkg.price', 'Precio del paquete'), money(paySale.price), 'text-gray-900'], [tt('paid', 'Pagado'), money(paySale.amount_paid), 'text-emerald-600'], [tt('transport.stat.pending', 'Por cobrar'), money(owed(paySale)), 'text-rose-600']].map(([l, v, c]) => (
                            <div key={l} className="bg-gray-50/70 rounded-xl py-3"><div className={`text-base font-black ${c}`}>{v}</div><div className="text-[8px] font-black text-gray-400 uppercase tracking-widest">{l}</div></div>
                        ))}
                    </div>
                    <div className="rounded-2xl border border-gray-100 divide-y divide-gray-50">
                        {payments.length === 0 && <div className="px-4 py-6 text-center text-xs text-gray-400 italic">{tt('transport.payments.none', 'Sin pagos registrados.')}</div>}
                        {payments.map(p => (
                            <div key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-black text-gray-800">{money(p.amount)} <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1">{paymentMethodLabel(tt, p.method)}</span></div>
                                    <div className="text-[10px] text-gray-400 font-bold">{fmtWhen(p.date)}{p.reference ? ` · ${p.reference}` : ''}</div>
                                </div>
                                {canManage && <button onClick={() => deletePayment(p)} title={tt('delete', 'Eliminar')} className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-gray-50 text-gray-400 hover:bg-rose-600 hover:text-white transition-all"><i className="fa-solid fa-trash-can text-[10px]"></i></button>}
                            </div>
                        ))}
                    </div>
                    {canManage && owed(paySale) > 0.004 && (
                        <div className="space-y-3 rounded-2xl border-2 border-gray-100 p-4">
                            <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest">{tt('transport.payment.new', 'Registrar pago')}</div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <input type="number" min={0} step="0.01" className={inputCls} value={payForm.amount} onChange={e => setPayForm({ ...payForm, amount: e.target.value })} aria-label={tt('amount', 'Monto')} />
                                <Select className={inputCls} value={payForm.method} onChange={e => setPayForm({ ...payForm, method: e.target.value })} aria-label={tt('payment.methods', 'Forma de pago')}>
                                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{paymentMethodLabel(tt, m)}</option>)}
                                </Select>
                                <input className={inputCls} value={payForm.reference} onChange={e => setPayForm({ ...payForm, reference: e.target.value })} placeholder={tt('reference', 'Referencia (opcional)')} aria-label={tt('reference', 'Referencia')} />
                                <DateField value={payForm.date} onChange={v => setPayForm({ ...payForm, date: v })} ariaLabel={tt('transport.payment.date', 'Fecha del pago')} />
                            </div>
                            <button onClick={addPayment} disabled={busy || !(Number(payForm.amount) > 0)} className="w-full px-6 py-3 bg-emerald-600 text-white rounded-2xl hover:bg-emerald-700 font-black text-[10px] uppercase tracking-widest shadow-lg shadow-emerald-500/30 disabled:opacity-50">
                                <i className="fa-solid fa-check mr-1.5"></i>{tt('transport.payment.save', 'Registrar pago')}
                            </button>
                        </div>
                    )}
                </Modal>
            )}

            {/* Message to a bus (2.27.0) */}
            {msgFor != null && buses.some(x => x.id === msgFor) && (() => {
                const b = buses.find(x => x.id === msgFor)!;
                return (
                    <Modal title={tt('transport.notice.message.title', 'Mensaje al bus')} subtitle={`${b.name} · ${alertsLine(b)}`} onClose={() => setMsgFor(null)}
                        footer={<>
                            <button onClick={() => setMsgFor(null)} className="px-5 py-2.5 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{tt('cancel', 'Cancelar')}</button>
                            <button onClick={sendMessage} disabled={busy || !msgText.trim()} data-bus-message-send="" className="px-6 py-2.5 bg-gray-900 text-white rounded-xl hover:bg-black font-black text-[10px] uppercase tracking-widest disabled:opacity-50"><i className="fa-solid fa-paper-plane mr-1.5" aria-hidden="true"></i>{tt('transport.notice.message.send', 'Enviar a los pasajeros')}</button>
                        </>}>
                        <div className="space-y-4">
                            <div>
                                <label htmlFor="bus-msg" className="block text-[10px] font-black uppercase tracking-widest text-gray-500 mb-1.5">{tt('transport.notice.message.label', 'Mensaje')}</label>
                                <textarea id="bus-msg" value={msgText} maxLength={240} rows={3} onChange={e => setMsgText(e.target.value)} autoFocus={canAutoFocus()}
                                    placeholder={tt('transport.notice.message.ph', 'Ej. El bus sale desde la puerta 3 del coliseo.')}
                                    className="w-full rounded-2xl border-2 border-gray-100 focus:border-sky-400 outline-none px-4 py-3 text-sm font-bold text-gray-800 resize-none" />
                                <div className="text-right text-[10px] font-bold text-gray-400">{msgText.length}/240</div>
                            </div>
                            <p className="text-[11px] text-gray-500">{tt('transport.notice.message.hint', 'Llega como notificación a quienes activaron los avisos y aparece en la página «Mi inscripción» de todos los pasajeros del bus.')}</p>
                            {notices.length > 0 && (
                                <div>
                                    <div className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-1.5">{tt('transport.notice.history', 'Avisos enviados')}</div>
                                    <ul className="rounded-2xl border border-gray-100 divide-y divide-gray-50 max-h-56 overflow-y-auto">
                                        {notices.map(n => (
                                            <li key={n.id} className="px-3 py-2 text-xs">
                                                <div className="flex justify-between gap-2"><span className="font-black text-gray-800">{NOTICE_LABEL[n.kind] || n.kind}</span><span className="text-gray-400 font-bold">{fmtClock(n.at)}</span></div>
                                                {n.text && <div className="text-gray-700" style={{ overflowWrap: 'anywhere' }}>{n.text}</div>}
                                                <div className="text-[10px] text-gray-400 font-bold">{tt('transport.notice.reached', '{sent} de {n} teléfonos').replace('{sent}', String(n.sent)).replace('{n}', String(n.recipients))}</div>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    </Modal>
                );
            })()}

            {/* Local confirm — above every modal of this page */}
            {confirmState && (
                <Overlay layer={4} backdrop="rgba(0,0,0,0.5)" className="backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 space-y-5" role="alertdialog" aria-modal="true">
                        <p className="text-sm font-bold text-gray-800">{confirmState.text}</p>
                        <div className="flex justify-end gap-2">
                            <button onClick={() => setConfirmState(null)} className="px-5 py-2.5 text-gray-500 font-bold hover:bg-gray-100 rounded-xl">{tt('cancel', 'Cancelar')}</button>
                            <button onClick={() => { const f = confirmState.onOk; setConfirmState(null); f(); }} className={`px-6 py-2.5 text-white rounded-xl font-black text-[10px] uppercase tracking-widest ${confirmState.tone === 'go' ? 'bg-gray-900 hover:bg-black' : 'bg-rose-600 hover:bg-rose-700'}`}>{confirmState.okLabel || tt('confirm', 'Confirmar')}</button>
                        </div>
                    </div>
                </Overlay>
            )}
        </div>
    );
}
