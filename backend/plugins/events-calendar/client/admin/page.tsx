// @ts-nocheck
"use client";

/**
 * Admin page for the Events Calendar plugin (/admin/plugin/events-calendar).
 * CRUD over events: filter chips (upcoming/past/all), a table with color dot + dates + actions,
 * and a modal form for create/edit. API calls go through the host's api helpers (session cookie).
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

const inputCls = "w-full px-4 py-3 bg-gray-50/60 border-2 border-gray-100 rounded-2xl focus:ring-4 focus:ring-blue-100 focus:border-blue-500 focus:bg-white transition-all outline-none font-medium";
const labelCls = "block text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2";
const btnCls = "px-5 py-3 bg-gray-900 hover:bg-blue-600 text-white rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";
const btnGhostCls = "px-5 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-2xl font-black text-xs uppercase tracking-widest transition-all disabled:opacity-50";

const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/**
 * Parse the stored local-naive ISO ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm') as LOCAL time.
 * new Date('YYYY-MM-DD') would parse as UTC midnight and show the previous day in
 * negative-offset timezones — so we construct the Date from parts.
 */
function parseIso(s) {
    const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
}

function fmtWhen(ev) {
    const start = parseIso(ev.starts_at);
    if (!start) return ev.starts_at || "";
    const datePart = (d) => `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
    const timePart = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const end = ev.ends_at ? parseIso(ev.ends_at) : null;

    if (ev.all_day) {
        if (end && end.toDateString() !== start.toDateString()) return `${datePart(start)} → ${datePart(end)} · Todo el día`;
        return `${datePart(start)} · Todo el día`;
    }
    if (!end) return `${datePart(start)} · ${timePart(start)}`;
    if (end.toDateString() === start.toDateString()) return `${datePart(start)} · ${timePart(start)} – ${timePart(end)}`;
    return `${datePart(start)} ${timePart(start)} → ${datePart(end)} ${timePart(end)}`;
}

/**
 * Create/edit modal. Module-level on purpose (defining it inside the page component would remount
 * it on every parent render and steal input focus). It owns its form state, seeded from `initial`.
 */
function EventModal({ initial, onClose, onSaved }) {
    const ev = initial || {};
    const [title, setTitle] = useState(ev.title || "");
    const [allDay, setAllDay] = useState(!!ev.all_day);
    const [startsAt, setStartsAt] = useState(ev.starts_at || "");
    const [endsAt, setEndsAt] = useState(ev.ends_at || "");
    const [location, setLocation] = useState(ev.location || "");
    const [url, setUrl] = useState(ev.url || "");
    const [color, setColor] = useState(/^#[0-9a-fA-F]{6}$/.test(ev.color || "") ? ev.color : "#3b82f6");
    const [description, setDescription] = useState(ev.description || "");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    const submit = async (e) => {
        e.preventDefault();
        setError("");
        if (!title.trim()) { setError("El título es obligatorio."); return; }
        if (!startsAt) { setError("La fecha de inicio es obligatoria."); return; }

        // All-day events carry date-only values in the inputs; normalize to the stored shape so
        // string comparison stays chronological ('T00:00' start, inclusive 'T23:59' end).
        const payload = {
            title: title.trim(),
            all_day: allDay ? 1 : 0,
            starts_at: allDay ? startsAt.slice(0, 10) + "T00:00" : startsAt,
            ends_at: endsAt ? (allDay ? endsAt.slice(0, 10) + "T23:59" : endsAt) : "",
            location: location.trim(),
            url: url.trim(),
            color,
            description: description.trim(),
        };
        if (payload.ends_at && payload.ends_at < payload.starts_at) {
            setError("La fecha de fin debe ser igual o posterior a la de inicio.");
            return;
        }
        if (ev.id) payload.id = ev.id;

        setBusy(true);
        try {
            await apiPost("/plugin/events-calendar/events", payload);
            onSaved(ev.id ? "Evento actualizado." : "Evento creado.");
        } catch (err) {
            setError(err?.message || "No se pudo guardar el evento.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
            <form
                onSubmit={submit}
                onClick={(e) => e.stopPropagation()}
                className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6 sm:p-8 space-y-4"
            >
                <h2 className="text-xl font-black text-gray-900 italic tracking-tighter">
                    {ev.id ? "Editar evento" : "Nuevo evento"}
                </h2>

                <div>
                    <label className={labelCls}>Título *</label>
                    <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder="Nombre del evento" required />
                </div>

                <label className="flex items-center gap-2 text-sm font-medium text-gray-600 cursor-pointer select-none">
                    <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
                    Todo el día
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Inicio *</label>
                        {allDay ? (
                            <input type="date" value={startsAt.slice(0, 10)} onChange={(e) => setStartsAt(e.target.value ? e.target.value + "T00:00" : "")} className={inputCls} required />
                        ) : (
                            <input type="datetime-local" value={startsAt.slice(0, 16)} onChange={(e) => setStartsAt(e.target.value)} className={inputCls} required />
                        )}
                    </div>
                    <div>
                        <label className={labelCls}>Fin (opcional)</label>
                        {allDay ? (
                            <input type="date" value={endsAt.slice(0, 10)} onChange={(e) => setEndsAt(e.target.value ? e.target.value + "T23:59" : "")} className={inputCls} />
                        ) : (
                            <input type="datetime-local" value={endsAt.slice(0, 16)} onChange={(e) => setEndsAt(e.target.value)} className={inputCls} />
                        )}
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                        <label className={labelCls}>Lugar</label>
                        <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} className={inputCls} placeholder="Auditorio, dirección…" />
                    </div>
                    <div>
                        <label className={labelCls}>Color</label>
                        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-12 w-full bg-gray-50/60 border-2 border-gray-100 rounded-2xl cursor-pointer p-1" />
                    </div>
                </div>

                <div>
                    <label className={labelCls}>Enlace "Más info" (opcional)</label>
                    <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} className={inputCls} placeholder="https://…" />
                </div>

                <div>
                    <label className={labelCls}>Descripción</label>
                    <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={inputCls} placeholder="Detalles del evento…" />
                </div>

                {error && <div className="text-sm px-4 py-3 rounded-xl bg-red-50 text-red-600">{error}</div>}

                <div className="flex items-center justify-end gap-3 pt-2">
                    <button type="button" onClick={onClose} disabled={busy} className={btnGhostCls}>Cancelar</button>
                    <button type="submit" disabled={busy} className={btnCls}>{busy ? "Guardando…" : "Guardar"}</button>
                </div>
            </form>
        </div>
    );
}

const SCOPES = [
    { value: "upcoming", label: "Próximos" },
    { value: "past", label: "Pasados" },
    { value: "all", label: "Todos" },
];

export default function EventsCalendarAdminPage() {
    const [events, setEvents] = useState(null); // null = loading
    const [scope, setScope] = useState("upcoming");
    const [message, setMessage] = useState("");
    const [modal, setModal] = useState(null); // null = closed, {} = new, {...event} = edit
    const [busyId, setBusyId] = useState(null);

    const load = async (s) => {
        try {
            const data = await api(`/plugin/events-calendar/events?scope=${s}`);
            setEvents(data.events || []);
        } catch (err) {
            setEvents([]);
            setMessage(`Error al cargar los eventos: ${err?.message || err}`);
        }
    };

    useEffect(() => { load(scope); }, [scope]);

    const remove = async (ev) => {
        if (!window.confirm(`¿Eliminar el evento "${ev.title}"? Esta acción no se puede deshacer.`)) return;
        setBusyId(ev.id);
        setMessage("");
        try {
            await apiDelete(`/plugin/events-calendar/events/${ev.id}`);
            setMessage("Evento eliminado.");
            load(scope);
        } catch (err) {
            setMessage(`Error al eliminar: ${err?.message || err}`);
        } finally {
            setBusyId(null);
        }
    };

    return (
        <div className="max-w-5xl mx-auto p-4 sm:p-8">
            <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-black text-gray-900 italic tracking-tighter">Eventos</h1>
                    <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mt-1">
                        Calendario de eventos → bloque EventsCalendar en el editor visual
                    </p>
                </div>
                <button type="button" onClick={() => setModal({})} className={btnCls}>+ Nuevo evento</button>
            </div>

            <div className="flex flex-wrap gap-2 mb-6">
                {SCOPES.map((s) => (
                    <button
                        key={s.value}
                        type="button"
                        onClick={() => setScope(s.value)}
                        className={`px-4 py-2 rounded-full text-xs font-black uppercase tracking-widest transition-all ${scope === s.value ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
                    >
                        {s.label}
                    </button>
                ))}
            </div>

            {message && (
                <div className={`text-sm px-4 py-3 rounded-xl mb-6 ${/Error/i.test(message) ? "bg-red-50 text-red-600" : "bg-green-50 text-green-700"}`}>
                    {message}
                </div>
            )}

            <div className="bg-white rounded-3xl border border-gray-100 shadow-xl shadow-gray-200/40 overflow-hidden">
                {events === null ? (
                    <p className="text-sm text-gray-400 p-8">Cargando eventos…</p>
                ) : events.length === 0 ? (
                    <p className="text-sm text-gray-400 p-8">
                        {scope === "upcoming" ? "No hay eventos próximos." : scope === "past" ? "No hay eventos pasados." : "Todavía no hay eventos — crea el primero."}
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-[10px] font-black uppercase tracking-widest text-gray-400 border-b border-gray-100">
                                    <th className="px-6 py-4">Evento</th>
                                    <th className="px-6 py-4">Fecha</th>
                                    <th className="px-6 py-4">Lugar</th>
                                    <th className="px-6 py-4 text-right">Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                {events.map((ev) => (
                                    <tr key={ev.id} className="border-b border-gray-50 hover:bg-gray-50/60 transition">
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-3">
                                                <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: ev.color || "#3b82f6" }} />
                                                <div>
                                                    <div className="font-bold text-gray-800">{ev.title}</div>
                                                    {ev.url && (
                                                        <a href={ev.url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-500 hover:underline break-all">
                                                            {ev.url}
                                                        </a>
                                                    )}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-gray-600 whitespace-nowrap">{fmtWhen(ev)}</td>
                                        <td className="px-6 py-4 text-gray-500">{ev.location || "—"}</td>
                                        <td className="px-6 py-4 text-right whitespace-nowrap">
                                            <button
                                                type="button"
                                                onClick={() => setModal(ev)}
                                                className="px-3 py-2 rounded-xl text-xs font-black uppercase tracking-widest text-gray-600 hover:bg-gray-100 transition"
                                            >
                                                Editar
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => remove(ev)}
                                                disabled={busyId === ev.id}
                                                className="px-3 py-2 rounded-xl text-xs font-black uppercase tracking-widest text-red-500 hover:bg-red-50 transition disabled:opacity-50"
                                            >
                                                Eliminar
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <p className="text-[11px] text-gray-400 mt-6 leading-relaxed">
                En el editor visual, agrega el bloque <strong>EventsCalendar</strong> — muestra los eventos como
                lista de próximos o como calendario mensual, con descripción opcional.
            </p>

            {modal !== null && (
                <EventModal
                    key={modal.id || "new"}
                    initial={modal.id ? modal : null}
                    onClose={() => setModal(null)}
                    onSaved={(msg) => { setModal(null); setMessage(msg); load(scope); }}
                />
            )}
        </div>
    );
}
