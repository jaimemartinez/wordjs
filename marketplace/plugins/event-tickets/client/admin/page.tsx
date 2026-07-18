// @ts-nocheck
"use client";

/**
 * Admin page for the Event Tickets plugin (/admin/plugin/tickets).
 * Tabs: Eventos (CRUD + nested ticket-type editor with sold/capacity bars), Pedidos (confirm
 * manual payments → generates + mails ticket codes, cancel), Asistentes (search + check-in by
 * code + CSV export), Configuración.
 */

import React, { useEffect, useRef, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnGhostCls = "px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-bold text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const cardCls = "bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8";

const EMPTY_EVENT = { title: "", starts_at: "", venue: "", description: "", is_published: true };
const EMPTY_TYPE = { name: "", price: "", capacity: "100", sales_end: "", is_active: true };

function fmtMoney(cents, symbol) {
    const n = Number(cents) || 0;
    return (symbol || "$") + (n % 100 === 0 ? String(n / 100) : (n / 100).toFixed(2));
}
function fmtDate(v) {
    if (!v) return "";
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });
}
function priceToCents(v) {
    const n = parseFloat(String(v).replace(",", "."));
    if (!isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
}

export default function EventTicketsAdminPage() {
    const [tab, setTab] = useState("eventos");
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);

    // Eventos
    const [events, setEvents] = useState([]);
    const [eventForm, setEventForm] = useState(null);   // null | {id?, ...EMPTY_EVENT}
    const [openEventId, setOpenEventId] = useState(null); // event whose types panel is expanded
    const [typeForm, setTypeForm] = useState(null);     // null | {id?, event_id, ...EMPTY_TYPE}

    // Pedidos
    const [orders, setOrders] = useState([]);
    const [pendingTotal, setPendingTotal] = useState(0);
    const [orderEventFilter, setOrderEventFilter] = useState("");
    const [orderStatusFilter, setOrderStatusFilter] = useState("");

    // Asistentes
    const [attendees, setAttendees] = useState([]);
    const [attEventFilter, setAttEventFilter] = useState("");
    const [attSearch, setAttSearch] = useState("");
    const [checkinCode, setCheckinCode] = useState("");
    const [checkinResult, setCheckinResult] = useState(null); // {kind:'ok'|'already'|'invalid', ...}
    const checkinInputRef = useRef(null);

    // Configuración
    const [config, setConfig] = useState({ currencySymbol: "$", manualInstructions: "", notifyEmail: "" });

    const flash = (msg) => { setMessage(msg); };

    // ── data loading ─────────────────────────────────────────────────────────────────────────────
    const loadEvents = async () => {
        try {
            const data = await api("/plugin/event-tickets/events");
            setEvents(data.events || []);
        } catch (err) {
            flash(`Error al cargar eventos: ${err?.message || err}`);
        }
    };
    const loadOrders = async (eventId = orderEventFilter, status = orderStatusFilter) => {
        try {
            const p = new URLSearchParams();
            if (eventId) p.set("event_id", eventId);
            if (status) p.set("status", status);
            const data = await api(`/plugin/event-tickets/orders?${p.toString()}`);
            setOrders(data.orders || []);
            setPendingTotal(data.pendingTotal || 0);
        } catch (err) {
            flash(`Error al cargar pedidos: ${err?.message || err}`);
        }
    };
    const loadAttendees = async (eventId = attEventFilter, search = attSearch) => {
        try {
            const p = new URLSearchParams();
            if (eventId) p.set("event_id", eventId);
            if (search) p.set("search", search);
            const data = await api(`/plugin/event-tickets/attendees?${p.toString()}`);
            setAttendees(data.attendees || []);
        } catch (err) {
            flash(`Error al cargar asistentes: ${err?.message || err}`);
        }
    };
    const loadConfig = async () => {
        try {
            const cfg = await api("/plugin/event-tickets/config");
            setConfig(cfg);
        } catch { /* keep defaults */ }
    };

    useEffect(() => { loadEvents(); loadOrders(); loadConfig(); }, []);
    useEffect(() => { if (tab === "pedidos") loadOrders(); }, [tab]);
    useEffect(() => { if (tab === "asistentes") { loadAttendees(); setTimeout(() => checkinInputRef.current?.focus(), 50); } }, [tab]);

    // ── eventos actions ──────────────────────────────────────────────────────────────────────────
    const saveEvent = async (e) => {
        e.preventDefault();
        if (!eventForm) return;
        setBusy(true); setMessage("");
        try {
            const body = {
                title: eventForm.title,
                starts_at: eventForm.starts_at,
                venue: eventForm.venue,
                description: eventForm.description,
                is_published: eventForm.is_published ? 1 : 0,
            };
            if (eventForm.id) await apiPut(`/plugin/event-tickets/events/${eventForm.id}`, body);
            else await apiPost("/plugin/event-tickets/events", body);
            setEventForm(null);
            await loadEvents();
            flash("Evento guardado.");
        } catch (err) {
            flash(`Error: ${err?.message || err}`);
        } finally { setBusy(false); }
    };
    const deleteEvent = async (ev) => {
        if (typeof window !== "undefined" && !window.confirm(`¿Eliminar "${ev.title}"? Se borrarán también sus tipos de entrada, pedidos y códigos.`)) return;
        setBusy(true);
        try {
            await apiDelete(`/plugin/event-tickets/events/${ev.id}`);
            await loadEvents();
            flash("Evento eliminado.");
        } catch (err) {
            flash(`Error: ${err?.message || err}`);
        } finally { setBusy(false); }
    };
    const saveType = async (e) => {
        e.preventDefault();
        if (!typeForm) return;
        const cents = priceToCents(typeForm.price === "" ? "0" : typeForm.price);
        if (cents === null) { flash("Precio inválido."); return; }
        const capacity = parseInt(typeForm.capacity, 10);
        if (!isFinite(capacity) || capacity < 1) { flash("Capacidad inválida."); return; }
        setBusy(true); setMessage("");
        try {
            const body = {
                name: typeForm.name,
                price_cents: cents,
                capacity,
                sales_end: typeForm.sales_end || "",
                is_active: typeForm.is_active ? 1 : 0,
            };
            if (typeForm.id) await apiPut(`/plugin/event-tickets/types/${typeForm.id}`, body);
            else await apiPost(`/plugin/event-tickets/events/${typeForm.event_id}/types`, body);
            setTypeForm(null);
            await loadEvents();
            flash("Tipo de entrada guardado.");
        } catch (err) {
            flash(`Error: ${err?.message || err}`);
        } finally { setBusy(false); }
    };
    const deleteType = async (t) => {
        if (typeof window !== "undefined" && !window.confirm(`¿Eliminar el tipo "${t.name}"?`)) return;
        setBusy(true);
        try {
            await apiDelete(`/plugin/event-tickets/types/${t.id}`);
            await loadEvents();
            flash("Tipo eliminado.");
        } catch (err) {
            flash(`Error: ${err?.message || err}`);
        } finally { setBusy(false); }
    };
    const toggleTypeActive = async (t) => {
        try {
            await apiPut(`/plugin/event-tickets/types/${t.id}`, { is_active: t.is_active ? 0 : 1 });
            await loadEvents();
        } catch (err) {
            flash(`Error: ${err?.message || err}`);
        }
    };

    // ── pedidos actions ──────────────────────────────────────────────────────────────────────────
    const confirmPaid = async (o) => {
        if (typeof window !== "undefined" && !window.confirm(`¿Confirmar el pago de ${o.buyer_name} por ${fmtMoney(o.total_cents, config.currencySymbol)}? Se generarán y enviarán los códigos.`)) return;
        setBusy(true); setMessage("");
        try {
            const r = await apiPost(`/plugin/event-tickets/orders/${o.id}/paid`, {});
            const n = (r.tickets || []).length;
            flash(r.already ? "Este pedido ya estaba pagado." : `Pago confirmado — ${n} código(s) generado(s)${r.emailSent ? " y enviados por correo" : " (correo no enviado)"}.`);
            await loadOrders();
            await loadEvents();
        } catch (err) {
            flash(`Error: ${err?.message || err}`);
        } finally { setBusy(false); }
    };
    const cancelOrder = async (o) => {
        if (typeof window !== "undefined" && !window.confirm(`¿Cancelar el pedido de ${o.buyer_name}? Se liberará el cupo y se anularán sus códigos.`)) return;
        setBusy(true); setMessage("");
        try {
            await apiPost(`/plugin/event-tickets/orders/${o.id}/cancel`, {});
            flash("Pedido cancelado.");
            await loadOrders();
            await loadEvents();
        } catch (err) {
            flash(`Error: ${err?.message || err}`);
        } finally { setBusy(false); }
    };

    // ── asistentes actions ───────────────────────────────────────────────────────────────────────
    const doCheckin = async (e) => {
        e.preventDefault();
        const code = checkinCode.trim();
        if (!code) return;
        setBusy(true); setCheckinResult(null);
        try {
            const r = await apiPost("/plugin/event-tickets/checkin", { code });
            if (r.already) setCheckinResult({ kind: "already", ...r });
            else setCheckinResult({ kind: "ok", ...r });
            setCheckinCode("");
            await loadAttendees();
        } catch (err) {
            setCheckinResult({ kind: "invalid", error: err?.message || "Código no válido" });
        } finally {
            setBusy(false);
            checkinInputRef.current?.focus();
        }
    };
    const undoCheckin = async (t) => {
        try {
            await apiPost(`/plugin/event-tickets/tickets/${t.id}/undo-checkin`, {});
            await loadAttendees();
        } catch (err) {
            flash(`Error: ${err?.message || err}`);
        }
    };
    const exportCsv = async () => {
        setBusy(true);
        try {
            const p = new URLSearchParams();
            if (attEventFilter) p.set("event_id", attEventFilter);
            if (attSearch) p.set("search", attSearch);
            const data = await api(`/plugin/event-tickets/attendees/export?${p.toString()}`);
            // The isolate can't stream files — the CSV arrives in JSON and downloads via Blob.
            // U+FEFF BOM so Excel opens the UTF-8 CSV with accents intact.
            const blob = new Blob(["\uFEFF" + (data.csv || "")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = data.filename || "asistentes.csv";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            flash(`Error al exportar: ${err?.message || err}`);
        } finally { setBusy(false); }
    };

    // ── config actions ───────────────────────────────────────────────────────────────────────────
    const saveConfig = async (e) => {
        e.preventDefault();
        setBusy(true); setMessage("");
        try {
            const cfg = await apiPost("/plugin/event-tickets/config", config);
            setConfig(cfg);
            flash("Configuración guardada.");
        } catch (err) {
            flash(`Error: ${err?.message || err}`);
        } finally { setBusy(false); }
    };

    const tabBtn = (id, label, badge = 0) => (
        <button
            type="button"
            onClick={() => { setTab(id); setMessage(""); }}
            className={`px-4 py-2.5 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${tab === id ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
        >
            {label}
            {badge > 0 && <span className="ml-2 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-amber-400 text-gray-900 text-[10px]">{badge}</span>}
        </button>
    );

    return (
        <div className="max-w-5xl mx-auto p-4 sm:p-8">
            <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Entradas</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Eventos → tipos de entrada → pedidos → códigos → check-in
                </p>
            </div>

            <div className="flex flex-wrap gap-2 mb-6">
                {tabBtn("eventos", "Eventos")}
                {tabBtn("pedidos", "Pedidos", pendingTotal)}
                {tabBtn("asistentes", "Asistentes")}
                {tabBtn("config", "Configuración")}
            </div>

            {message && (
                <div className={`text-sm px-4 py-3 rounded-xl mb-6 ${/Error|falló|no enviado/i.test(message) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>{message}</div>
            )}

            {/* ═══════════ EVENTOS ═══════════ */}
            {tab === "eventos" && (
                <div className="space-y-6">
                    <div className="flex justify-end">
                        <button type="button" className={btnCls} onClick={() => setEventForm({ ...EMPTY_EVENT })}>+ Nuevo evento</button>
                    </div>

                    {eventForm && (
                        <form onSubmit={saveEvent} className={`${cardCls} space-y-4`}>
                            <h2 className="font-bold text-gray-800">{eventForm.id ? "Editar evento" : "Nuevo evento"}</h2>
                            <div className="grid sm:grid-cols-2 gap-4">
                                <div>
                                    <label className={labelCls}>Título *</label>
                                    <input className={inputCls} value={eventForm.title} onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })} required />
                                </div>
                                <div>
                                    <label className={labelCls}>Fecha y hora *</label>
                                    <input type="datetime-local" className={inputCls} value={eventForm.starts_at} onChange={(e) => setEventForm({ ...eventForm, starts_at: e.target.value })} required />
                                </div>
                                <div>
                                    <label className={labelCls}>Lugar</label>
                                    <input className={inputCls} value={eventForm.venue} onChange={(e) => setEventForm({ ...eventForm, venue: e.target.value })} />
                                </div>
                                <div className="flex items-end pb-2">
                                    <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                                        <input type="checkbox" checked={!!eventForm.is_published} onChange={(e) => setEventForm({ ...eventForm, is_published: e.target.checked })} />
                                        Publicado (visible en el bloque público)
                                    </label>
                                </div>
                            </div>
                            <div>
                                <label className={labelCls}>Descripción</label>
                                <textarea className={inputCls} rows={3} value={eventForm.description} onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })} />
                            </div>
                            <div className="flex justify-end gap-3">
                                <button type="button" className={btnGhostCls} onClick={() => setEventForm(null)}>Cancelar</button>
                                <button type="submit" className={btnCls} disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
                            </div>
                        </form>
                    )}

                    {events.length === 0 && !eventForm && (
                        <div className={`${cardCls} text-center text-gray-400 text-sm`}>Sin eventos todavía — crea el primero.</div>
                    )}

                    {events.map((ev) => (
                        <div key={ev.id} className={cardCls}>
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                    <h3 className="font-black text-gray-900 text-lg">
                                        {ev.title}
                                        {!ev.is_published && <span className="ml-2 text-[10px] font-black uppercase tracking-widest bg-gray-200 text-gray-500 px-2 py-0.5 rounded-full align-middle">Borrador</span>}
                                    </h3>
                                    <p className="text-xs text-gray-400 font-bold uppercase tracking-widest mt-1">
                                        {fmtDate(ev.starts_at)}{ev.venue ? ` · ${ev.venue}` : ""}
                                    </p>
                                </div>
                                <div className="flex gap-2">
                                    <button type="button" className={btnGhostCls} onClick={() => setOpenEventId(openEventId === ev.id ? null : ev.id)}>
                                        {openEventId === ev.id ? "Ocultar entradas" : `Entradas (${(ev.types || []).length})`}
                                    </button>
                                    <button type="button" className={btnGhostCls} onClick={() => setEventForm({ id: ev.id, title: ev.title, starts_at: ev.starts_at, venue: ev.venue || "", description: ev.description || "", is_published: !!ev.is_published })}>Editar</button>
                                    <button type="button" className="px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-bold text-xs uppercase tracking-widest transition-all" onClick={() => deleteEvent(ev)}>Eliminar</button>
                                </div>
                            </div>

                            {openEventId === ev.id && (
                                <div className="mt-5 border-t border-gray-100 pt-5 space-y-3">
                                    {(ev.types || []).map((t) => {
                                        const cap = Number(t.capacity) || 0;
                                        const sold = Number(t.sold) || 0;
                                        const pct = cap > 0 ? Math.min(100, Math.round((sold / cap) * 100)) : 0;
                                        return (
                                            <div key={t.id} className="flex flex-wrap items-center gap-3 bg-gray-50/60 rounded-2xl px-4 py-3">
                                                <div className="flex-1 min-w-[180px]">
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-bold text-gray-800">{t.name}</span>
                                                        <span className="text-xs font-black text-gray-500">{Number(t.price_cents) > 0 ? fmtMoney(t.price_cents, config.currencySymbol) : "Gratis"}</span>
                                                        {!t.is_active && <span className="text-[10px] font-black uppercase bg-gray-200 text-gray-500 px-2 py-0.5 rounded-full">Inactivo</span>}
                                                        {t.sales_end && <span className="text-[10px] text-gray-400">venta hasta {fmtDate(t.sales_end)}</span>}
                                                    </div>
                                                    <div className="mt-1.5 h-2 bg-gray-200 rounded-full overflow-hidden max-w-[260px]">
                                                        <div className={`h-full rounded-full ${pct >= 100 ? "bg-red-400" : pct >= 80 ? "bg-amber-400" : "bg-green-400"}`} style={{ width: `${pct}%` }} />
                                                    </div>
                                                    <p className="text-[11px] text-gray-400 mt-1">{sold} / {cap} vendidas · quedan {Math.max(0, cap - sold)}</p>
                                                </div>
                                                <div className="flex gap-2">
                                                    <button type="button" className={btnGhostCls} onClick={() => toggleTypeActive(t)}>{t.is_active ? "Desactivar" : "Activar"}</button>
                                                    <button type="button" className={btnGhostCls} onClick={() => setTypeForm({ id: t.id, event_id: ev.id, name: t.name, price: String((Number(t.price_cents) || 0) / 100), capacity: String(t.capacity), sales_end: t.sales_end || "", is_active: !!t.is_active })}>Editar</button>
                                                    <button type="button" className="px-3 py-2 bg-red-50 hover:bg-red-100 text-red-500 rounded-xl font-bold text-[11px] uppercase tracking-widest" onClick={() => deleteType(t)}>×</button>
                                                </div>
                                            </div>
                                        );
                                    })}

                                    {typeForm && typeForm.event_id === ev.id ? (
                                        <form onSubmit={saveType} className="bg-blue-50/40 rounded-2xl p-4 grid sm:grid-cols-5 gap-3 items-end">
                                            <div className="sm:col-span-2">
                                                <label className={labelCls}>Nombre *</label>
                                                <input className={inputCls} value={typeForm.name} onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })} placeholder="General, VIP…" required />
                                            </div>
                                            <div>
                                                <label className={labelCls}>Precio ({config.currencySymbol})</label>
                                                <input className={inputCls} value={typeForm.price} onChange={(e) => setTypeForm({ ...typeForm, price: e.target.value })} placeholder="0 = gratis" inputMode="decimal" />
                                            </div>
                                            <div>
                                                <label className={labelCls}>Capacidad *</label>
                                                <input type="number" min={1} className={inputCls} value={typeForm.capacity} onChange={(e) => setTypeForm({ ...typeForm, capacity: e.target.value })} required />
                                            </div>
                                            <div>
                                                <label className={labelCls}>Fin de venta</label>
                                                <input type="datetime-local" className={inputCls} value={typeForm.sales_end} onChange={(e) => setTypeForm({ ...typeForm, sales_end: e.target.value })} />
                                            </div>
                                            <div className="sm:col-span-5 flex items-center justify-between">
                                                <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                                                    <input type="checkbox" checked={!!typeForm.is_active} onChange={(e) => setTypeForm({ ...typeForm, is_active: e.target.checked })} />
                                                    Activo (a la venta)
                                                </label>
                                                <div className="flex gap-2">
                                                    <button type="button" className={btnGhostCls} onClick={() => setTypeForm(null)}>Cancelar</button>
                                                    <button type="submit" className={btnCls} disabled={busy}>Guardar tipo</button>
                                                </div>
                                            </div>
                                        </form>
                                    ) : (
                                        <button type="button" className={btnGhostCls} onClick={() => setTypeForm({ event_id: ev.id, ...EMPTY_TYPE })}>+ Agregar tipo de entrada</button>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* ═══════════ PEDIDOS ═══════════ */}
            {tab === "pedidos" && (
                <div className={cardCls}>
                    <div className="flex flex-wrap gap-3 mb-5">
                        <select className={`${inputCls} max-w-[240px]`} value={orderEventFilter} onChange={(e) => { setOrderEventFilter(e.target.value); loadOrders(e.target.value, orderStatusFilter); }}>
                            <option value="">Todos los eventos</option>
                            {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.title}</option>)}
                        </select>
                        <select className={`${inputCls} max-w-[200px]`} value={orderStatusFilter} onChange={(e) => { setOrderStatusFilter(e.target.value); loadOrders(orderEventFilter, e.target.value); }}>
                            <option value="">Todos los estados</option>
                            <option value="pending">Pendiente</option>
                            <option value="paid">Pagado</option>
                            <option value="cancelled">Cancelado</option>
                        </select>
                    </div>

                    {orders.length === 0 ? (
                        <p className="text-sm text-gray-400">No hay pedidos con estos filtros.</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                        <th className="py-2 pr-4">Comprador</th>
                                        <th className="py-2 pr-4">Evento</th>
                                        <th className="py-2 pr-4">Entradas</th>
                                        <th className="py-2 pr-4">Total</th>
                                        <th className="py-2 pr-4">Estado</th>
                                        <th className="py-2 pr-4">Fecha</th>
                                        <th className="py-2"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {orders.map((o) => (
                                        <tr key={o.id} className="border-b border-gray-50 align-top">
                                            <td className="py-3 pr-4">
                                                <div className="font-bold text-gray-800">{o.buyer_name}</div>
                                                <div className="text-[11px] text-gray-400">{o.buyer_email}</div>
                                            </td>
                                            <td className="py-3 pr-4 text-gray-600">{o.event_title || "—"}</td>
                                            <td className="py-3 pr-4 text-gray-600">
                                                {(o.items || []).map((it, i) => <div key={i}>{it.qty}× {it.name}</div>)}
                                            </td>
                                            <td className="py-3 pr-4 font-bold text-gray-800">{fmtMoney(o.total_cents, config.currencySymbol)}</td>
                                            <td className="py-3 pr-4">
                                                <span className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full ${o.payment_status === "paid" ? "bg-green-100 text-green-700" : o.payment_status === "pending" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"}`}>
                                                    {o.payment_status === "paid" ? "Pagado" : o.payment_status === "pending" ? "Pendiente" : "Cancelado"}
                                                </span>
                                            </td>
                                            <td className="py-3 pr-4 text-[11px] text-gray-400 whitespace-nowrap">{fmtDate(o.created_at)}</td>
                                            <td className="py-3 whitespace-nowrap">
                                                {o.payment_status === "pending" && (
                                                    <button type="button" className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg font-bold text-[11px] uppercase tracking-widest mr-2 disabled:opacity-50" disabled={busy} onClick={() => confirmPaid(o)}>Confirmar pago</button>
                                                )}
                                                {o.payment_status !== "cancelled" && (
                                                    <button type="button" className="px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg font-bold text-[11px] uppercase tracking-widest disabled:opacity-50" disabled={busy} onClick={() => cancelOrder(o)}>Cancelar</button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {/* ═══════════ ASISTENTES ═══════════ */}
            {tab === "asistentes" && (
                <div className="space-y-6">
                    <form onSubmit={doCheckin} className={`${cardCls} space-y-4`}>
                        <h2 className="font-bold text-gray-800">Check-in por código</h2>
                        <div className="flex flex-wrap gap-3">
                            <input
                                ref={checkinInputRef}
                                className={`${inputCls} flex-1 min-w-[220px] font-mono text-lg tracking-[0.3em] uppercase`}
                                value={checkinCode}
                                onChange={(e) => setCheckinCode(e.target.value.toUpperCase())}
                                placeholder="ESCRIBE O PEGA EL CÓDIGO"
                                autoComplete="off"
                            />
                            <button type="submit" className={btnCls} disabled={busy || !checkinCode.trim()}>Registrar</button>
                        </div>
                        {checkinResult && checkinResult.kind === "ok" && (
                            <div className="bg-green-50 border-2 border-green-200 rounded-2xl px-5 py-4 text-green-700 text-xl font-black">
                                ✔ {checkinResult.attendee} — {checkinResult.type || "Entrada"}
                                {checkinResult.event ? <span className="block text-xs font-bold uppercase tracking-widest text-green-500 mt-1">{checkinResult.event}</span> : null}
                            </div>
                        )}
                        {checkinResult && checkinResult.kind === "already" && (
                            <div className="bg-amber-50 border-2 border-amber-200 rounded-2xl px-5 py-4 text-amber-700 text-lg font-black">
                                Ya registrado a las {fmtDate(checkinResult.at)} — {checkinResult.attendee}
                            </div>
                        )}
                        {checkinResult && checkinResult.kind === "invalid" && (
                            <div className="bg-red-50 border-2 border-red-200 rounded-2xl px-5 py-4 text-red-600 text-lg font-black">
                                ✕ {checkinResult.error || "Código no válido"}
                            </div>
                        )}
                    </form>

                    <div className={cardCls}>
                        <div className="flex flex-wrap gap-3 mb-5">
                            <select className={`${inputCls} max-w-[240px]`} value={attEventFilter} onChange={(e) => { setAttEventFilter(e.target.value); loadAttendees(e.target.value, attSearch); }}>
                                <option value="">Todos los eventos</option>
                                {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.title}</option>)}
                            </select>
                            <input
                                className={`${inputCls} flex-1 min-w-[200px]`}
                                value={attSearch}
                                onChange={(e) => setAttSearch(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); loadAttendees(attEventFilter, attSearch); } }}
                                placeholder="Buscar por código, nombre o correo…"
                            />
                            <button type="button" className={btnGhostCls} onClick={() => loadAttendees(attEventFilter, attSearch)}>Buscar</button>
                            <button type="button" className={btnCls} onClick={exportCsv} disabled={busy}>Exportar CSV</button>
                        </div>

                        {attendees.length === 0 ? (
                            <p className="text-sm text-gray-400">Sin asistentes — los códigos aparecen cuando un pedido queda pagado.</p>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                            <th className="py-2 pr-4">Código</th>
                                            <th className="py-2 pr-4">Asistente</th>
                                            <th className="py-2 pr-4">Tipo</th>
                                            <th className="py-2 pr-4">Evento</th>
                                            <th className="py-2 pr-4">Check-in</th>
                                            <th className="py-2"></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {attendees.map((t) => (
                                            <tr key={t.id} className="border-b border-gray-50">
                                                <td className="py-3 pr-4 font-mono font-bold tracking-widest text-gray-800">{t.code}</td>
                                                <td className="py-3 pr-4">
                                                    <div className="font-bold text-gray-800">{t.attendee_name || t.buyer_name}</div>
                                                    <div className="text-[11px] text-gray-400">{t.buyer_email}</div>
                                                </td>
                                                <td className="py-3 pr-4 text-gray-600">{t.type_name || "—"}</td>
                                                <td className="py-3 pr-4 text-gray-600">{t.event_title || "—"}</td>
                                                <td className="py-3 pr-4">
                                                    {t.checked_in_at
                                                        ? <span className="text-[11px] font-bold text-green-600">✔ {fmtDate(t.checked_in_at)}</span>
                                                        : <span className="text-[11px] text-gray-300">—</span>}
                                                </td>
                                                <td className="py-3">
                                                    {t.checked_in_at && (
                                                        <button type="button" className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-500 rounded-lg font-bold text-[11px] uppercase tracking-widest" onClick={() => undoCheckin(t)}>Deshacer</button>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ═══════════ CONFIGURACIÓN ═══════════ */}
            {tab === "config" && (
                <form onSubmit={saveConfig} className={`${cardCls} space-y-5 max-w-2xl`}>
                    <h2 className="font-bold text-gray-800">Configuración</h2>
                    <div className="grid sm:grid-cols-2 gap-4">
                        <div>
                            <label className={labelCls}>Símbolo de moneda</label>
                            <input className={inputCls} value={config.currencySymbol} onChange={(e) => setConfig({ ...config, currencySymbol: e.target.value })} placeholder="$" />
                        </div>
                        <div>
                            <label className={labelCls}>Correo de notificaciones</label>
                            <input type="email" className={inputCls} value={config.notifyEmail} onChange={(e) => setConfig({ ...config, notifyEmail: e.target.value })} placeholder="opcional — recibe cada pedido nuevo" />
                        </div>
                    </div>
                    <div>
                        <label className={labelCls}>Instrucciones de pago manual</label>
                        <textarea className={inputCls} rows={4} value={config.manualInstructions} onChange={(e) => setConfig({ ...config, manualInstructions: e.target.value })} placeholder="Ej.: Transfiere el total a la cuenta 123-456 y envía el comprobante a pagos@misitio.com. Confirmaremos tu pago en menos de 24 h." />
                        <p className="text-[11px] text-gray-400 mt-2">Se muestran al comprador cuando el pedido tiene costo, en la página y en el correo de "pedido recibido".</p>
                    </div>
                    <div className="flex justify-end">
                        <button type="submit" className={btnCls} disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
                    </div>
                </form>
            )}
        </div>
    );
}
