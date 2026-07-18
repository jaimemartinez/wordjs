// @ts-nocheck
"use client";

/**
 * Admin page for the Bookings plugin (/admin/plugin/bookings).
 * Tabs: Agenda (day/week list grouped by day, colored by service, status changes, CSV export),
 * Servicios (CRUD modal with a per-weekday availability editor), Configuración (notification
 * email + minimum notice hours). All calls go through the host api helpers (session cookie).
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";

const BASE = "/plugin/bookings";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnGhostCls = "px-5 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const cardCls = "bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 p-6 sm:p-8";

const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_ES = { mon: "Lunes", tue: "Martes", wed: "Miércoles", thu: "Jueves", fri: "Viernes", sat: "Sábado", sun: "Domingo" };
const DOW_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const STATUS_ES = { confirmed: "Confirmada", cancelled: "Cancelada", completed: "Completada" };
const STATUS_BADGE = {
    confirmed: "bg-green-100 text-green-700",
    cancelled: "bg-red-100 text-red-600",
    completed: "bg-blue-100 text-blue-700",
};

const pad2 = (n) => String(n).padStart(2, "0");
const toDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromDateStr = (s) => new Date(`${s}T00:00:00`);
const addDays = (s, n) => {
    const d = fromDateStr(s);
    return toDateStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};
const mondayOf = (s) => {
    const d = fromDateStr(s);
    const shift = (d.getDay() + 6) % 7; // 0 = Monday
    return toDateStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() - shift));
};
const prettyDate = (s) => {
    const d = fromDateStr(s);
    return `${DOW_ES[d.getDay()]} ${d.getDate()}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
};
const fmtPrice = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

// ── Servicios: create/edit modal (module level — never define a component inside a component) ──

const emptyServiceForm = () => ({
    name: "",
    description: "",
    duration_min: 60,
    price: "0.00",
    color: "#3b82f6",
    is_active: true,
    availability: {},
});

function ServiceModal({ service, onClose, onSaved }) {
    const [form, setForm] = useState(() => {
        if (!service) return emptyServiceForm();
        return {
            name: service.name || "",
            description: service.description || "",
            duration_min: service.duration_min || 60,
            price: (Number(service.price_cents || 0) / 100).toFixed(2),
            color: service.color || "#3b82f6",
            is_active: service.is_active !== 0,
            availability: service.availability && typeof service.availability === "object" ? service.availability : {},
        };
    });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const setDay = (day, ranges) => {
        const availability = { ...form.availability };
        if (ranges.length) availability[day] = ranges;
        else delete availability[day];
        setForm({ ...form, availability });
    };
    const addRange = (day) => {
        const cur = form.availability[day] || [];
        setDay(day, [...cur, { start: "09:00", end: "17:00" }]);
    };
    const updateRange = (day, idx, key, value) => {
        const cur = (form.availability[day] || []).map((r, i) => (i === idx ? { ...r, [key]: value } : r));
        setDay(day, cur);
    };
    const removeRange = (day, idx) => {
        setDay(day, (form.availability[day] || []).filter((_, i) => i !== idx));
    };

    const save = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            const cents = Math.round(parseFloat(String(form.price).replace(",", ".")) * 100);
            const body = {
                name: form.name,
                description: form.description,
                duration_min: parseInt(form.duration_min, 10),
                price_cents: Number.isFinite(cents) && cents >= 0 ? cents : 0,
                color: form.color,
                is_active: form.is_active ? 1 : 0,
                availability: form.availability,
            };
            if (service) await apiPut(`${BASE}/services/${service.id}`, body);
            else await apiPost(`${BASE}/services`, body);
            onSaved();
        } catch (err) {
            setError(err?.message || "No se pudo guardar el servicio.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
            <form onSubmit={save} className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl my-8 p-6 sm:p-8 space-y-5" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-xl font-black text-gray-900 tracking-tighter italic">
                    {service ? "Editar servicio" : "Nuevo servicio"}
                </h2>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="sm:col-span-2">
                        <label className={labelCls}>Nombre *</label>
                        <input type="text" className={inputCls} value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                    </div>
                    <div className="sm:col-span-2">
                        <label className={labelCls}>Descripción</label>
                        <textarea className={inputCls} rows={2} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                    </div>
                    <div>
                        <label className={labelCls}>Duración (min) *</label>
                        <input type="number" className={inputCls} min={5} max={480} value={form.duration_min} onChange={(e) => setForm({ ...form, duration_min: e.target.value })} required />
                    </div>
                    <div>
                        <label className={labelCls}>Precio</label>
                        <input type="text" inputMode="decimal" className={inputCls} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="0.00" />
                    </div>
                    <div>
                        <label className={labelCls}>Color</label>
                        <input type="color" className="w-16 h-12 rounded-xl border-2 border-gray-100 cursor-pointer" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />
                    </div>
                    <div className="flex items-end pb-2">
                        <label className="flex items-center gap-2 text-sm font-bold text-gray-600 cursor-pointer select-none">
                            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                            Activo (visible al público)
                        </label>
                    </div>
                </div>

                <div>
                    <label className={labelCls}>Disponibilidad semanal</label>
                    <p className="text-[11px] text-gray-400 mb-3">
                        Los turnos se generan cada {form.duration_min || 60} minutos dentro de cada rango. Puedes agregar varios rangos por día (turno partido).
                    </p>
                    <div className="space-y-2">
                        {DAY_ORDER.map((day) => {
                            const ranges = form.availability[day] || [];
                            return (
                                <div key={day} className="flex flex-wrap items-start gap-2 bg-gray-50/60 rounded-2xl px-4 py-3">
                                    <div className="w-24 pt-2 text-xs font-black uppercase tracking-widest text-gray-500">{DAY_ES[day]}</div>
                                    <div className="flex-1 space-y-2">
                                        {ranges.length === 0 && <div className="text-xs text-gray-300 pt-2 font-bold">Cerrado</div>}
                                        {ranges.map((r, idx) => (
                                            <div key={idx} className="flex items-center gap-2">
                                                <input type="time" className="px-3 py-2 bg-white border-2 border-gray-100 rounded-xl text-sm font-medium outline-none focus:border-blue-500" value={r.start} onChange={(e) => updateRange(day, idx, "start", e.target.value)} required />
                                                <span className="text-gray-300 font-bold">→</span>
                                                <input type="time" className="px-3 py-2 bg-white border-2 border-gray-100 rounded-xl text-sm font-medium outline-none focus:border-blue-500" value={r.end} onChange={(e) => updateRange(day, idx, "end", e.target.value)} required />
                                                <button type="button" onClick={() => removeRange(day, idx)} className="text-red-400 hover:text-red-600 font-black text-lg leading-none px-2" title="Quitar rango">×</button>
                                            </div>
                                        ))}
                                    </div>
                                    <button type="button" onClick={() => addRange(day)} className="mt-1 px-3 py-2 bg-white border-2 border-gray-100 hover:border-blue-400 rounded-xl text-xs font-black text-gray-500">
                                        + Rango
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {error && <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600">{error}</div>}

                <div className="flex items-center justify-end gap-3 pt-2">
                    <button type="button" onClick={onClose} className={btnGhostCls}>Cancelar</button>
                    <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>
            </form>
        </div>
    );
}

// ── main page ───────────────────────────────────────────────────────────────────────────────────

export default function BookingsAdminPage() {
    const [tab, setTab] = useState("agenda");

    // Agenda state
    const [viewMode, setViewMode] = useState("week"); // 'day' | 'week'
    const [anchor, setAnchor] = useState(() => toDateStr(new Date()));
    const [statusFilter, setStatusFilter] = useState("");
    const [serviceFilter, setServiceFilter] = useState("");
    const [bookings, setBookings] = useState(null);
    const [agendaMsg, setAgendaMsg] = useState("");

    // Services state
    const [services, setServices] = useState(null);
    const [modalService, setModalService] = useState(undefined); // undefined = closed, null = new, obj = edit
    const [servicesMsg, setServicesMsg] = useState("");

    // Config state
    const [config, setConfig] = useState({ notifyEmail: "", minNoticeHours: 0 });
    const [configBusy, setConfigBusy] = useState(false);
    const [configMsg, setConfigMsg] = useState("");

    const rangeFrom = viewMode === "day" ? anchor : mondayOf(anchor);
    const rangeTo = viewMode === "day" ? anchor : addDays(mondayOf(anchor), 6);

    const loadBookings = async () => {
        try {
            const params = new URLSearchParams({ from: rangeFrom, to: rangeTo });
            if (statusFilter) params.set("status", statusFilter);
            if (serviceFilter) params.set("service_id", serviceFilter);
            const rows = await api(`${BASE}/bookings?${params.toString()}`);
            setBookings(Array.isArray(rows) ? rows : []);
        } catch (err) {
            setBookings([]);
            setAgendaMsg(`Error al cargar la agenda: ${err?.message || err}`);
        }
    };

    const loadServices = async () => {
        try {
            const rows = await api(`${BASE}/services`);
            setServices(Array.isArray(rows) ? rows : []);
        } catch {
            setServices([]);
        }
    };

    const loadConfig = async () => {
        try {
            const cfg = await api(`${BASE}/config`);
            setConfig({ notifyEmail: cfg.notifyEmail || "", minNoticeHours: cfg.minNoticeHours || 0 });
        } catch { /* keep defaults */ }
    };

    useEffect(() => { loadServices(); loadConfig(); }, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { loadBookings(); }, [anchor, viewMode, statusFilter, serviceFilter]);

    const changeStatus = async (id, status) => {
        setAgendaMsg("");
        try {
            await apiPost(`${BASE}/bookings/${id}/status`, { status });
            loadBookings();
        } catch (err) {
            setAgendaMsg(`Error al cambiar el estado: ${err?.message || err}`);
        }
    };

    const deleteBooking = async (id) => {
        if (typeof window !== "undefined" && !window.confirm("¿Eliminar esta reserva definitivamente?")) return;
        setAgendaMsg("");
        try {
            await apiDelete(`${BASE}/bookings/${id}`);
            loadBookings();
        } catch (err) {
            setAgendaMsg(`Error al eliminar: ${err?.message || err}`);
        }
    };

    const exportCsv = async () => {
        setAgendaMsg("");
        try {
            const params = new URLSearchParams({ from: rangeFrom, to: rangeTo });
            if (statusFilter) params.set("status", statusFilter);
            if (serviceFilter) params.set("service_id", serviceFilter);
            const data = await api(`${BASE}/bookings/export?${params.toString()}`);
            // UTF-8 BOM so Excel opens the CSV with accents intact.
            const blob = new Blob(["\uFEFF" + (data.csv || "")], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = data.filename || "reservas.csv";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            setAgendaMsg(`Error al exportar: ${err?.message || err}`);
        }
    };

    const deleteService = async (svc) => {
        if (typeof window !== "undefined" && !window.confirm(`¿Eliminar el servicio "${svc.name}"?`)) return;
        setServicesMsg("");
        try {
            await apiDelete(`${BASE}/services/${svc.id}`);
            loadServices();
        } catch (err) {
            setServicesMsg(`${err?.message || err}`);
        }
    };

    const toggleService = async (svc) => {
        setServicesMsg("");
        try {
            await apiPut(`${BASE}/services/${svc.id}`, {
                name: svc.name,
                description: svc.description || "",
                duration_min: svc.duration_min,
                price_cents: svc.price_cents || 0,
                color: svc.color,
                availability: svc.availability || {},
                is_active: svc.is_active ? 0 : 1,
            });
            loadServices();
        } catch (err) {
            setServicesMsg(`${err?.message || err}`);
        }
    };

    const saveConfig = async (e) => {
        e.preventDefault();
        setConfigBusy(true);
        setConfigMsg("");
        try {
            const cfg = await apiPost(`${BASE}/config`, {
                notifyEmail: config.notifyEmail,
                minNoticeHours: Number(config.minNoticeHours) || 0,
            });
            setConfig({ notifyEmail: cfg.notifyEmail || "", minNoticeHours: cfg.minNoticeHours || 0 });
            setConfigMsg("Configuración guardada.");
        } catch (err) {
            setConfigMsg(`Error: ${err?.message || err}`);
        } finally {
            setConfigBusy(false);
        }
    };

    // Group bookings by date for the agenda list.
    const grouped = [];
    if (Array.isArray(bookings)) {
        const map = new Map();
        for (const b of bookings) {
            if (!map.has(b.date)) { map.set(b.date, []); grouped.push({ date: b.date, items: map.get(b.date) }); }
            map.get(b.date).push(b);
        }
    }

    const tabBtn = (id, label) => (
        <button
            type="button"
            onClick={() => setTab(id)}
            className={`px-5 py-3 rounded-2xl font-black text-xs uppercase tracking-widest transition-all ${tab === id ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
        >
            {label}
        </button>
    );

    return (
        <div className="max-w-5xl mx-auto p-4 sm:p-8">
            <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Reservas</h1>
                <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                    Servicios con disponibilidad semanal · agenda · confirmaciones por correo
                </p>
            </div>

            <div className="flex flex-wrap gap-2 mb-6">
                {tabBtn("agenda", "Agenda")}
                {tabBtn("servicios", "Servicios")}
                {tabBtn("config", "Configuración")}
            </div>

            {/* ══════════ AGENDA ══════════ */}
            {tab === "agenda" && (
                <div className={cardCls}>
                    <div className="flex flex-wrap items-center gap-3 mb-6">
                        <div className="flex items-center gap-1 bg-gray-100 rounded-2xl p-1">
                            <button type="button" onClick={() => setViewMode("day")} className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest ${viewMode === "day" ? "bg-white shadow text-gray-900" : "text-gray-400"}`}>Día</button>
                            <button type="button" onClick={() => setViewMode("week")} className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest ${viewMode === "week" ? "bg-white shadow text-gray-900" : "text-gray-400"}`}>Semana</button>
                        </div>
                        <div className="flex items-center gap-1">
                            <button type="button" onClick={() => setAnchor(addDays(anchor, viewMode === "day" ? -1 : -7))} className="w-10 h-10 rounded-xl bg-gray-100 hover:bg-gray-200 font-black">‹</button>
                            <input type="date" className="px-3 py-2 bg-gray-50/60 border-2 border-gray-100 rounded-xl font-medium outline-none focus:border-blue-500" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)} />
                            <button type="button" onClick={() => setAnchor(addDays(anchor, viewMode === "day" ? 1 : 7))} className="w-10 h-10 rounded-xl bg-gray-100 hover:bg-gray-200 font-black">›</button>
                            <button type="button" onClick={() => setAnchor(toDateStr(new Date()))} className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-xs font-black uppercase tracking-widest text-gray-500">Hoy</button>
                        </div>
                        <div className="flex items-center gap-2 ml-auto">
                            <select className="px-3 py-2 bg-gray-50/60 border-2 border-gray-100 rounded-xl text-sm font-medium outline-none focus:border-blue-500" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                                <option value="">Todos los estados</option>
                                <option value="confirmed">Confirmadas</option>
                                <option value="completed">Completadas</option>
                                <option value="cancelled">Canceladas</option>
                            </select>
                            <select className="px-3 py-2 bg-gray-50/60 border-2 border-gray-100 rounded-xl text-sm font-medium outline-none focus:border-blue-500" value={serviceFilter} onChange={(e) => setServiceFilter(e.target.value)}>
                                <option value="">Todos los servicios</option>
                                {(services || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                            <button type="button" onClick={exportCsv} className={btnGhostCls}>Exportar CSV</button>
                        </div>
                    </div>

                    <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-4">
                        {rangeFrom === rangeTo ? prettyDate(rangeFrom) : `${prettyDate(rangeFrom)} — ${prettyDate(rangeTo)}`}
                    </p>

                    {agendaMsg && <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600 mb-4">{agendaMsg}</div>}

                    {bookings === null ? (
                        <p className="text-sm text-gray-400">Cargando agenda…</p>
                    ) : grouped.length === 0 ? (
                        <p className="text-sm text-gray-400">No hay reservas en este rango.</p>
                    ) : (
                        <div className="space-y-6">
                            {grouped.map((g) => (
                                <div key={g.date}>
                                    <h3 className="text-sm font-black text-gray-700 capitalize mb-2">{prettyDate(g.date)}</h3>
                                    <div className="space-y-2">
                                        {g.items.map((b) => (
                                            <div key={b.id} className="flex flex-wrap items-center gap-3 bg-gray-50/60 rounded-2xl px-4 py-3 border-l-4" style={{ borderLeftColor: b.service_color || "#3b82f6" }}>
                                                <div className="font-black text-gray-900 tabular-nums w-14">{b.time}</div>
                                                <div className="min-w-[140px]">
                                                    <div className="font-bold text-gray-800 text-sm">{b.service_name || "Servicio eliminado"}</div>
                                                    <div className="text-[11px] text-gray-400">{b.duration_min ? `${b.duration_min} min` : ""}</div>
                                                </div>
                                                <div className="flex-1 min-w-[180px]">
                                                    <div className="font-medium text-sm text-gray-700">{b.customer_name}</div>
                                                    <div className="text-[11px] text-gray-400">
                                                        {b.customer_email}{b.customer_phone ? ` · ${b.customer_phone}` : ""}
                                                    </div>
                                                    {b.notes ? <div className="text-[11px] text-gray-400 italic mt-0.5">“{b.notes}”</div> : null}
                                                </div>
                                                <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${STATUS_BADGE[b.status] || "bg-gray-100 text-gray-500"}`}>
                                                    {STATUS_ES[b.status] || b.status}
                                                </span>
                                                <select
                                                    className="px-2 py-1.5 bg-white border-2 border-gray-100 rounded-xl text-xs font-bold outline-none focus:border-blue-500"
                                                    value={b.status}
                                                    onChange={(e) => changeStatus(b.id, e.target.value)}
                                                >
                                                    <option value="confirmed">Confirmada</option>
                                                    <option value="completed">Completada</option>
                                                    <option value="cancelled">Cancelada</option>
                                                </select>
                                                <button type="button" onClick={() => deleteBooking(b.id)} className="text-red-300 hover:text-red-600 font-black px-1" title="Eliminar">×</button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ══════════ SERVICIOS ══════════ */}
            {tab === "servicios" && (
                <div className={cardCls}>
                    <div className="flex items-center justify-between mb-6">
                        <h2 className="font-bold text-gray-800">Servicios</h2>
                        <button type="button" onClick={() => setModalService(null)} className={btnCls}>+ Nuevo servicio</button>
                    </div>

                    {servicesMsg && <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600 mb-4">{servicesMsg}</div>}

                    {services === null ? (
                        <p className="text-sm text-gray-400">Cargando servicios…</p>
                    ) : services.length === 0 ? (
                        <p className="text-sm text-gray-400">Sin servicios todavía — crea el primero para empezar a recibir reservas.</p>
                    ) : (
                        <div className="space-y-2">
                            {services.map((s) => {
                                const days = DAY_ORDER.filter((d) => (s.availability && s.availability[d] || []).length > 0);
                                return (
                                    <div key={s.id} className="flex flex-wrap items-center gap-3 bg-gray-50/60 rounded-2xl px-4 py-3 border-l-4" style={{ borderLeftColor: s.color || "#3b82f6" }}>
                                        <div className="flex-1 min-w-[180px]">
                                            <div className="font-bold text-gray-800">{s.name} {!s.is_active && <span className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">(inactivo)</span>}</div>
                                            <div className="text-[11px] text-gray-400">
                                                {s.duration_min} min · {Number(s.price_cents) > 0 ? fmtPrice(s.price_cents) : "Gratis"} ·
                                                {days.length ? ` ${days.map((d) => DAY_ES[d].slice(0, 3)).join(", ")}` : " sin disponibilidad"}
                                            </div>
                                        </div>
                                        <button type="button" onClick={() => toggleService(s)} className={btnGhostCls}>{s.is_active ? "Desactivar" : "Activar"}</button>
                                        <button type="button" onClick={() => setModalService(s)} className={btnGhostCls}>Editar</button>
                                        <button type="button" onClick={() => deleteService(s)} className="px-5 py-3 bg-red-50 hover:bg-red-100 text-red-500 rounded-2xl font-black text-xs uppercase tracking-widest transition-all">Eliminar</button>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <p className="text-[11px] text-gray-400 mt-6 leading-relaxed">
                        En el editor visual, agrega el bloque <strong>Bookings</strong> a una página — muestra el selector de
                        servicios, el calendario de horarios y el formulario de reserva. Configura el campo "Servicio (ID)" del
                        bloque con el ID de un servicio para saltarte el selector.
                    </p>
                </div>
            )}

            {/* ══════════ CONFIGURACIÓN ══════════ */}
            {tab === "config" && (
                <form onSubmit={saveConfig} className={`${cardCls} space-y-5 max-w-xl`}>
                    <h2 className="font-bold text-gray-800">Configuración</h2>
                    <div>
                        <label className={labelCls}>Email de notificaciones (nuevas reservas)</label>
                        <input type="email" className={inputCls} value={config.notifyEmail} placeholder="(vacío = no notificar)" onChange={(e) => setConfig({ ...config, notifyEmail: e.target.value })} />
                    </div>
                    <div>
                        <label className={labelCls}>Antelación mínima (horas)</label>
                        <input type="number" min={0} max={720} className={inputCls} value={config.minNoticeHours} onChange={(e) => setConfig({ ...config, minNoticeHours: e.target.value })} />
                        <p className="text-[11px] text-gray-400 mt-2">
                            No se ofrecerán horarios que empiecen antes de este número de horas a partir de ahora (0 = permitir el mismo día).
                        </p>
                    </div>
                    {configMsg && <div className={`text-sm px-4 py-3 rounded-xl ${/^Error/.test(configMsg) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>{configMsg}</div>}
                    <div className="flex justify-end">
                        <button type="submit" disabled={configBusy} className={btnCls}>{configBusy ? "Guardando…" : "Guardar"}</button>
                    </div>
                </form>
            )}

            {modalService !== undefined && (
                <ServiceModal
                    service={modalService}
                    onClose={() => setModalService(undefined)}
                    onSaved={() => { setModalService(undefined); loadServices(); }}
                />
            )}
        </div>
    );
}
