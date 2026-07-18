// @ts-nocheck
"use client";

/**
 * Admin page for the Events Calendar plugin (/admin/plugin/events-calendar).
 * CRUD over events: filter chips (upcoming/past/all), a table with color dot + dates + actions,
 * and a modal form for create/edit. API calls go through the host's api helpers (session cookie).
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the
 * host admin shell and scoped to .plugin-admin-events-calendar) — the markup below only uses
 * cf-* classes plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useState } from "react";
import { api, apiPost, apiDelete } from "@/lib/api";

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

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconCalendar = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
);
const IconPlus = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" {...props}>
        <path d="M12 5v14M5 12h14" />
    </svg>
);
const IconPen = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
);
const IconCalendarEmpty = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
        <path d="m9.5 15.5 5 0" />
    </svg>
);

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
        <div className="cf-overlay" onClick={onClose}>
            <form
                onSubmit={submit}
                onClick={(e) => e.stopPropagation()}
                className="cf-letter"
                role="dialog"
                aria-modal="true"
                aria-label={ev.id ? "Editar evento" : "Nuevo evento"}
            >
                <div className="cf-letter-body">
                    <h2 className="cf-editor-title">
                        {ev.id ? <IconPen /> : <IconPlus />}
                        {ev.id ? "Editar evento" : "Nuevo evento"}
                    </h2>

                    <div className="cf-grid">
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="ec-title">Título *</label>
                            <input id="ec-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} className="cf-input" placeholder="Nombre del evento" required />
                        </div>

                        <div className="cf-span-2">
                            <label className="cf-check">
                                <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
                                Todo el día
                            </label>
                        </div>

                        <div>
                            <label className="cf-label" htmlFor="ec-starts">Inicio *</label>
                            {allDay ? (
                                <input id="ec-starts" type="date" value={startsAt.slice(0, 10)} onChange={(e) => setStartsAt(e.target.value ? e.target.value + "T00:00" : "")} className="cf-input" required />
                            ) : (
                                <input id="ec-starts" type="datetime-local" value={startsAt.slice(0, 16)} onChange={(e) => setStartsAt(e.target.value)} className="cf-input" required />
                            )}
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="ec-ends">Fin (opcional)</label>
                            {allDay ? (
                                <input id="ec-ends" type="date" value={endsAt.slice(0, 10)} onChange={(e) => setEndsAt(e.target.value ? e.target.value + "T23:59" : "")} className="cf-input" />
                            ) : (
                                <input id="ec-ends" type="datetime-local" value={endsAt.slice(0, 16)} onChange={(e) => setEndsAt(e.target.value)} className="cf-input" />
                            )}
                        </div>

                        <div>
                            <label className="cf-label" htmlFor="ec-location">Lugar</label>
                            <input id="ec-location" type="text" value={location} onChange={(e) => setLocation(e.target.value)} className="cf-input" placeholder="Auditorio, dirección…" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="ec-color">Color</label>
                            <input id="ec-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="cf-color-input" />
                        </div>

                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="ec-url">Enlace "Más info" (opcional)</label>
                            <input id="ec-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} className="cf-input" placeholder="https://…" />
                        </div>

                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="ec-description">Descripción</label>
                            <textarea id="ec-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="cf-input" placeholder="Detalles del evento…" />
                        </div>
                    </div>

                    {error && <div role="alert" className="cf-flash is-error" style={{ marginTop: "1.05rem", marginBottom: 0 }}>{error}</div>}

                    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}>
                        <button type="button" onClick={onClose} disabled={busy} className="cf-btn-ghost">Cancelar</button>
                        <button type="submit" disabled={busy} className="cf-btn">{busy ? "Guardando…" : "Guardar"}</button>
                    </div>
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
        <div className="cf-shell">
            {/* header: stamp + title + primary action */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconCalendar /></div>
                <div style={{ minWidth: 0 }}>
                    <h1 className="cf-title">Eventos</h1>
                    <p className="cf-subtitle">Calendario de eventos → bloque EventsCalendar en el editor visual</p>
                </div>
                <div style={{ marginLeft: "auto" }}>
                    <button type="button" onClick={() => setModal({})} className="cf-btn"><IconPlus /> Nuevo evento</button>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* scope filter: segmented pill */}
            <div className="cf-tabs" role="tablist">
                {SCOPES.map((s) => (
                    <button
                        key={s.value}
                        type="button"
                        role="tab"
                        aria-selected={scope === s.value}
                        onClick={() => setScope(s.value)}
                        className={`cf-tab ${scope === s.value ? "is-active" : ""}`}
                    >
                        {s.label}
                    </button>
                ))}
            </div>

            {message && (
                <div role={/Error/i.test(message) ? "alert" : "status"} className={`cf-flash ${/Error/i.test(message) ? "is-error" : "is-ok"}`}>
                    {message}
                </div>
            )}

            <div className="cf-card-item">
                {events === null ? (
                    <div className="cf-empty">
                        <IconCalendarEmpty />
                        <span>Cargando eventos…</span>
                    </div>
                ) : events.length === 0 ? (
                    <div className="cf-empty">
                        <IconCalendarEmpty />
                        <span>
                            {scope === "upcoming" ? "No hay eventos próximos." : scope === "past" ? "No hay eventos pasados." : "Todavía no hay eventos — crea el primero."}
                        </span>
                    </div>
                ) : (
                    <div className="cf-table-wrap">
                        <table className="cf-table">
                            <thead>
                                <tr>
                                    <th>Evento</th>
                                    <th>Fecha</th>
                                    <th>Lugar</th>
                                    <th style={{ textAlign: "right" }}>Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                {events.map((ev) => (
                                    <tr key={ev.id}>
                                        <td>
                                            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                                                <span className="cf-event-dot" aria-hidden="true" style={{ backgroundColor: ev.color || "#3b82f6" }} />
                                                <div style={{ minWidth: 0 }}>
                                                    <div className="cf-event-title">{ev.title}</div>
                                                    {ev.url && (
                                                        <a href={ev.url} target="_blank" rel="noopener noreferrer" className="cf-event-url">
                                                            {ev.url}
                                                        </a>
                                                    )}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="cf-cell-date">{fmtWhen(ev)}</td>
                                        <td>{ev.location || "—"}</td>
                                        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                                            <div style={{ display: "inline-flex", gap: "0.5rem" }}>
                                                <button type="button" onClick={() => setModal(ev)} className="cf-btn-ghost">
                                                    <IconPen /> Editar
                                                </button>
                                                <button type="button" onClick={() => remove(ev)} disabled={busyId === ev.id} className="cf-btn-danger">
                                                    Eliminar
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <p className="cf-footnote">
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
