// @ts-nocheck
"use client";

/**
 * Admin page for the Event Tickets plugin (/admin/plugin/tickets).
 * Tabs: Eventos (CRUD + nested ticket-type editor with sold/capacity bars), Pedidos (confirm
 * manual payments → generates + mails ticket codes, cancel), Asistentes (search + check-in by
 * code + CSV export), Configuración.
 *
 * Visual identity lives in the plugin's OWN stylesheet (client/admin/admin.css, injected by the
 * host admin shell and scoped to .plugin-admin-tickets) — the markup below only uses cf-*
 * classes plus sparse inline styles for one-off layout.
 */

import React, { useEffect, useRef, useState } from "react";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";

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

/* Tiny inline icon set (stroke 2, currentColor) so the identity needs no icon-font. */
const IconTicket = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M2 9a3 3 0 0 1 0 6v3a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-3a3 3 0 0 1 0-6V6a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1Z" />
        <path d="M13 5v2M13 11v2M13 17v2" />
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
const IconDownload = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m7 10 5 5 5-5" />
        <path d="M12 15V3" />
    </svg>
);
const IconCheck = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M20 6 9 17l-5-5" />
    </svg>
);
const IconX = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" {...props}>
        <path d="M18 6 6 18M6 6l12 12" />
    </svg>
);
const IconSearch = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
    </svg>
);
const IconCalendar = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
);
const IconUsers = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
);
const IconSliders = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" {...props}>
        <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </svg>
);

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
            role="tab"
            aria-selected={tab === id}
            onClick={() => { setTab(id); setMessage(""); }}
            className={`cf-tab ${tab === id ? "is-active" : ""}`}
        >
            {label}
            {badge > 0 && <span className="cf-badge">{badge}</span>}
        </button>
    );

    const isErrorMsg = /Error|falló|no enviado/i.test(message);

    return (
        <div className="cf-shell">
            {/* header: stamp + title + rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconTicket /></div>
                <div>
                    <h1 className="cf-title">Entradas</h1>
                    <p className="cf-subtitle">Eventos → tipos de entrada → pedidos → códigos → check-in</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* tabs */}
            <div className="cf-tabs" role="tablist">
                {tabBtn("eventos", "Eventos")}
                {tabBtn("pedidos", "Pedidos", pendingTotal)}
                {tabBtn("asistentes", "Asistentes")}
                {tabBtn("config", "Configuración")}
            </div>

            {message && (
                <div role={isErrorMsg ? "alert" : "status"} className={`cf-flash ${isErrorMsg ? "is-error" : "is-ok"}`}>{message}</div>
            )}

            {/* ═══════════ EVENTOS ═══════════ */}
            {tab === "eventos" && (
                <div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                        <button type="button" className="cf-btn" onClick={() => setEventForm({ ...EMPTY_EVENT })}><IconPlus /> Nuevo evento</button>
                    </div>

                    {eventForm && (
                        <form onSubmit={saveEvent} className="cf-editor">
                            <div className="cf-editor-body">
                                <h2 className="cf-editor-title"><IconPen /> {eventForm.id ? "Editar evento" : "Nuevo evento"}</h2>
                                <div className="cf-grid">
                                    <div>
                                        <label className="cf-label" htmlFor="et-ev-title">Título *</label>
                                        <input id="et-ev-title" className="cf-input" value={eventForm.title} onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })} required />
                                    </div>
                                    <div>
                                        <label className="cf-label" htmlFor="et-ev-starts">Fecha y hora *</label>
                                        <input id="et-ev-starts" type="datetime-local" className="cf-input" value={eventForm.starts_at} onChange={(e) => setEventForm({ ...eventForm, starts_at: e.target.value })} required />
                                    </div>
                                    <div>
                                        <label className="cf-label" htmlFor="et-ev-venue">Lugar</label>
                                        <input id="et-ev-venue" className="cf-input" value={eventForm.venue} onChange={(e) => setEventForm({ ...eventForm, venue: e.target.value })} />
                                    </div>
                                    <div style={{ display: "flex", alignItems: "flex-end" }}>
                                        <label className="cf-check">
                                            <input type="checkbox" checked={!!eventForm.is_published} onChange={(e) => setEventForm({ ...eventForm, is_published: e.target.checked })} />
                                            Publicado (visible en el bloque público)
                                        </label>
                                    </div>
                                    <div className="cf-span-2">
                                        <label className="cf-label" htmlFor="et-ev-desc">Descripción</label>
                                        <textarea id="et-ev-desc" className="cf-input" rows={3} value={eventForm.description} onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })} />
                                    </div>
                                </div>
                                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}>
                                    <button type="button" className="cf-btn-ghost" onClick={() => setEventForm(null)}>Cancelar</button>
                                    <button type="submit" className="cf-btn" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
                                </div>
                            </div>
                        </form>
                    )}

                    {events.length === 0 && !eventForm && (
                        <div className="cf-empty">
                            <IconCalendar />
                            <span>Sin eventos todavía — crea el primero.</span>
                        </div>
                    )}

                    {events.map((ev) => (
                        <div key={ev.id} className="cf-card-item">
                            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                                        <h3 className="cf-form-name">{ev.title}</h3>
                                        {!ev.is_published && <span className="cf-chip">Borrador</span>}
                                    </div>
                                    <p className="cf-meta">{fmtDate(ev.starts_at)}{ev.venue ? ` · ${ev.venue}` : ""}</p>
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                                    <button type="button" className="cf-btn-ghost" onClick={() => setOpenEventId(openEventId === ev.id ? null : ev.id)}>
                                        <IconTicket /> {openEventId === ev.id ? "Ocultar entradas" : `Entradas (${(ev.types || []).length})`}
                                    </button>
                                    <button type="button" className="cf-btn-ghost" onClick={() => setEventForm({ id: ev.id, title: ev.title, starts_at: ev.starts_at, venue: ev.venue || "", description: ev.description || "", is_published: !!ev.is_published })}><IconPen /> Editar</button>
                                    <button type="button" className="cf-btn-danger" onClick={() => deleteEvent(ev)}>Eliminar</button>
                                </div>
                            </div>

                            {openEventId === ev.id && (
                                <div className="cf-types">
                                    {(ev.types || []).map((t) => {
                                        const cap = Number(t.capacity) || 0;
                                        const sold = Number(t.sold) || 0;
                                        const pct = cap > 0 ? Math.min(100, Math.round((sold / cap) * 100)) : 0;
                                        return (
                                            <div key={t.id} className="cf-type-row">
                                                <div style={{ flex: 1, minWidth: "180px" }}>
                                                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                                                        <span className="cf-type-name">{t.name}</span>
                                                        <span className="cf-type-price">{Number(t.price_cents) > 0 ? fmtMoney(t.price_cents, config.currencySymbol) : "Gratis"}</span>
                                                        {!t.is_active && <span className="cf-chip">Inactivo</span>}
                                                        {t.sales_end && <span className="cf-type-note" style={{ marginTop: 0 }}>venta hasta {fmtDate(t.sales_end)}</span>}
                                                    </div>
                                                    <div className="cf-meter" role="img" aria-label={`${pct}% vendido`}>
                                                        <div className={`cf-meter-fill ${pct >= 100 ? "is-full" : pct >= 80 ? "is-warn" : ""}`} style={{ width: `${pct}%` }} />
                                                    </div>
                                                    <p className="cf-type-note">{sold} / {cap} vendidas · quedan {Math.max(0, cap - sold)}</p>
                                                </div>
                                                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                                                    <button type="button" className="cf-btn-ghost" onClick={() => toggleTypeActive(t)}>{t.is_active ? "Desactivar" : "Activar"}</button>
                                                    <button type="button" className="cf-btn-ghost" onClick={() => setTypeForm({ id: t.id, event_id: ev.id, name: t.name, price: String((Number(t.price_cents) || 0) / 100), capacity: String(t.capacity), sales_end: t.sales_end || "", is_active: !!t.is_active })}><IconPen /> Editar</button>
                                                    <button type="button" title="Eliminar tipo" aria-label={`Eliminar tipo ${t.name}`} className="cf-iconbtn is-danger" onClick={() => deleteType(t)}>×</button>
                                                </div>
                                            </div>
                                        );
                                    })}

                                    {typeForm && typeForm.event_id === ev.id ? (
                                        <form onSubmit={saveType} className="cf-type-editor">
                                            <div className="cf-type-grid">
                                                <div>
                                                    <label className="cf-label" htmlFor="et-tt-name">Nombre *</label>
                                                    <input id="et-tt-name" className="cf-input" value={typeForm.name} onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })} placeholder="General, VIP…" required />
                                                </div>
                                                <div>
                                                    <label className="cf-label" htmlFor="et-tt-price">Precio ({config.currencySymbol})</label>
                                                    <input id="et-tt-price" className="cf-input" value={typeForm.price} onChange={(e) => setTypeForm({ ...typeForm, price: e.target.value })} placeholder="0 = gratis" inputMode="decimal" />
                                                </div>
                                                <div>
                                                    <label className="cf-label" htmlFor="et-tt-cap">Capacidad *</label>
                                                    <input id="et-tt-cap" type="number" min={1} className="cf-input" value={typeForm.capacity} onChange={(e) => setTypeForm({ ...typeForm, capacity: e.target.value })} required />
                                                </div>
                                                <div>
                                                    <label className="cf-label" htmlFor="et-tt-end">Fin de venta</label>
                                                    <input id="et-tt-end" type="datetime-local" className="cf-input" value={typeForm.sales_end} onChange={(e) => setTypeForm({ ...typeForm, sales_end: e.target.value })} />
                                                </div>
                                                <div className="cf-span-full" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
                                                    <label className="cf-check">
                                                        <input type="checkbox" checked={!!typeForm.is_active} onChange={(e) => setTypeForm({ ...typeForm, is_active: e.target.checked })} />
                                                        Activo (a la venta)
                                                    </label>
                                                    <div style={{ display: "flex", gap: "0.5rem" }}>
                                                        <button type="button" className="cf-btn-ghost" onClick={() => setTypeForm(null)}>Cancelar</button>
                                                        <button type="submit" className="cf-btn" disabled={busy}>Guardar tipo</button>
                                                    </div>
                                                </div>
                                            </div>
                                        </form>
                                    ) : (
                                        <div>
                                            <button type="button" className="cf-btn-ghost" onClick={() => setTypeForm({ event_id: ev.id, ...EMPTY_TYPE })}><IconPlus /> Agregar tipo de entrada</button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* ═══════════ PEDIDOS ═══════════ */}
            {tab === "pedidos" && (
                <div className="cf-card-item">
                    <div className="cf-toolbar">
                        <div className="cf-toolbar-left">
                            <select className="cf-select" aria-label="Filtrar por evento" value={orderEventFilter} onChange={(e) => { setOrderEventFilter(e.target.value); loadOrders(e.target.value, orderStatusFilter); }}>
                                <option value="">Todos los eventos</option>
                                {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.title}</option>)}
                            </select>
                            <select className="cf-select" aria-label="Filtrar por estado" value={orderStatusFilter} onChange={(e) => { setOrderStatusFilter(e.target.value); loadOrders(orderEventFilter, e.target.value); }}>
                                <option value="">Todos los estados</option>
                                <option value="pending">Pendiente</option>
                                <option value="paid">Pagado</option>
                                <option value="cancelled">Cancelado</option>
                            </select>
                        </div>
                    </div>

                    {orders.length === 0 ? (
                        <div className="cf-empty">
                            <IconTicket />
                            <span>No hay pedidos con estos filtros.</span>
                        </div>
                    ) : (
                        <div className="cf-table-wrap">
                            <table className="cf-table">
                                <thead>
                                    <tr>
                                        <th>Comprador</th>
                                        <th>Evento</th>
                                        <th>Entradas</th>
                                        <th>Total</th>
                                        <th>Estado</th>
                                        <th>Fecha</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {orders.map((o) => (
                                        <tr key={o.id} className="cf-row-static" style={{ verticalAlign: "top" }}>
                                            <td>
                                                <div className="cf-cell-main">{o.buyer_name}</div>
                                                <div className="cf-cell-sub">{o.buyer_email}</div>
                                            </td>
                                            <td>{o.event_title || "—"}</td>
                                            <td>
                                                {(o.items || []).map((it, i) => <div key={i}>{it.qty}× {it.name}</div>)}
                                            </td>
                                            <td className="cf-cell-main" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{fmtMoney(o.total_cents, config.currencySymbol)}</td>
                                            <td>
                                                <span className={`cf-pill ${o.payment_status === "paid" ? "is-ok" : o.payment_status === "pending" ? "is-warn" : "is-muted"}`}>
                                                    {o.payment_status === "paid" ? "Pagado" : o.payment_status === "pending" ? "Pendiente" : "Cancelado"}
                                                </span>
                                            </td>
                                            <td className="cf-cell-date">{fmtDate(o.created_at)}</td>
                                            <td>
                                                <div className="cf-cell-actions">
                                                    {o.payment_status === "pending" && (
                                                        <button type="button" className="cf-btn" disabled={busy} onClick={() => confirmPaid(o)}><IconCheck /> Confirmar pago</button>
                                                    )}
                                                    {o.payment_status !== "cancelled" && (
                                                        <button type="button" className="cf-btn-danger" disabled={busy} onClick={() => cancelOrder(o)}>Cancelar</button>
                                                    )}
                                                </div>
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
                <div>
                    <form onSubmit={doCheckin} className="cf-editor">
                        <div className="cf-editor-body">
                            <h2 className="cf-editor-title"><IconCheck /> Check-in por código</h2>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
                                <input
                                    ref={checkinInputRef}
                                    id="et-checkin"
                                    aria-label="Código de la entrada"
                                    className="cf-input cf-code-input"
                                    style={{ flex: 1, minWidth: "220px", width: "auto" }}
                                    value={checkinCode}
                                    onChange={(e) => setCheckinCode(e.target.value.toUpperCase())}
                                    placeholder="ESCRIBE O PEGA EL CÓDIGO"
                                    autoComplete="off"
                                />
                                <button type="submit" className="cf-btn" disabled={busy || !checkinCode.trim()}>Registrar</button>
                            </div>
                            {checkinResult && checkinResult.kind === "ok" && (
                                <div className="cf-checkin is-ok" role="status">
                                    <IconCheck />
                                    <div>
                                        {checkinResult.attendee} — {checkinResult.type || "Entrada"}
                                        {checkinResult.event ? <span className="cf-checkin-sub">{checkinResult.event}</span> : null}
                                    </div>
                                </div>
                            )}
                            {checkinResult && checkinResult.kind === "already" && (
                                <div className="cf-checkin is-warn" role="status">
                                    <IconTicket />
                                    <div>Ya registrado a las {fmtDate(checkinResult.at)} — {checkinResult.attendee}</div>
                                </div>
                            )}
                            {checkinResult && checkinResult.kind === "invalid" && (
                                <div className="cf-checkin is-error" role="alert">
                                    <IconX />
                                    <div>{checkinResult.error || "Código no válido"}</div>
                                </div>
                            )}
                        </div>
                    </form>

                    <div className="cf-card-item">
                        <div className="cf-toolbar">
                            <div className="cf-toolbar-left" style={{ flex: 1 }}>
                                <select className="cf-select" aria-label="Filtrar por evento" value={attEventFilter} onChange={(e) => { setAttEventFilter(e.target.value); loadAttendees(e.target.value, attSearch); }}>
                                    <option value="">Todos los eventos</option>
                                    {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.title}</option>)}
                                </select>
                                <input
                                    className="cf-input"
                                    aria-label="Buscar asistentes"
                                    style={{ flex: 1, minWidth: "200px", width: "auto" }}
                                    value={attSearch}
                                    onChange={(e) => setAttSearch(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); loadAttendees(attEventFilter, attSearch); } }}
                                    placeholder="Buscar por código, nombre o correo…"
                                />
                                <button type="button" className="cf-btn-ghost" onClick={() => loadAttendees(attEventFilter, attSearch)}><IconSearch /> Buscar</button>
                            </div>
                            <button type="button" className="cf-btn" onClick={exportCsv} disabled={busy}><IconDownload /> Exportar CSV</button>
                        </div>

                        {attendees.length === 0 ? (
                            <div className="cf-empty">
                                <IconUsers />
                                <span>Sin asistentes — los códigos aparecen cuando un pedido queda pagado.</span>
                            </div>
                        ) : (
                            <div className="cf-table-wrap">
                                <table className="cf-table">
                                    <thead>
                                        <tr>
                                            <th>Código</th>
                                            <th>Asistente</th>
                                            <th>Tipo</th>
                                            <th>Evento</th>
                                            <th>Check-in</th>
                                            <th></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {attendees.map((t) => (
                                            <tr key={t.id} className="cf-row-static">
                                                <td className="cf-cell-code">{t.code}</td>
                                                <td>
                                                    <div className="cf-cell-main">{t.attendee_name || t.buyer_name}</div>
                                                    <div className="cf-cell-sub">{t.buyer_email}</div>
                                                </td>
                                                <td>{t.type_name || "—"}</td>
                                                <td>{t.event_title || "—"}</td>
                                                <td>
                                                    {t.checked_in_at
                                                        ? <span className="cf-checked"><IconCheck /> {fmtDate(t.checked_in_at)}</span>
                                                        : <span className="cf-void">—</span>}
                                                </td>
                                                <td style={{ textAlign: "right" }}>
                                                    {t.checked_in_at && (
                                                        <button type="button" className="cf-btn-ghost" onClick={() => undoCheckin(t)}>Deshacer</button>
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
                <form onSubmit={saveConfig} className="cf-editor" style={{ maxWidth: "42rem" }}>
                    <div className="cf-editor-body">
                        <h2 className="cf-editor-title"><IconSliders /> Configuración</h2>
                        <div className="cf-grid">
                            <div>
                                <label className="cf-label" htmlFor="et-cfg-symbol">Símbolo de moneda</label>
                                <input id="et-cfg-symbol" className="cf-input" value={config.currencySymbol} onChange={(e) => setConfig({ ...config, currencySymbol: e.target.value })} placeholder="$" />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="et-cfg-notify">Correo de notificaciones</label>
                                <input id="et-cfg-notify" type="email" className="cf-input" value={config.notifyEmail} onChange={(e) => setConfig({ ...config, notifyEmail: e.target.value })} placeholder="opcional — recibe cada pedido nuevo" />
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="et-cfg-instr">Instrucciones de pago manual</label>
                                <textarea id="et-cfg-instr" className="cf-input" rows={4} value={config.manualInstructions} onChange={(e) => setConfig({ ...config, manualInstructions: e.target.value })} placeholder="Ej.: Transfiere el total a la cuenta 123-456 y envía el comprobante a pagos@misitio.com. Confirmaremos tu pago en menos de 24 h." />
                                <p className="cf-help">Se muestran al comprador cuando el pedido tiene costo, en la página y en el correo de "pedido recibido".</p>
                            </div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.5rem" }}>
                            <button type="submit" className="cf-btn" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
                        </div>
                    </div>
                </form>
            )}
        </div>
    );
}
