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
import { useT } from "./i18n";

const EMPTY_EVENT = { title: "", starts_at: "", venue: "", description: "", is_published: true };
const EMPTY_TYPE = { name: "", price: "", capacity: "100", sales_end: "", is_active: true };

function fmtMoney(cents, symbol) {
    const n = Number(cents) || 0;
    return (symbol || "$") + (n % 100 === 0 ? String(n / 100) : (n / 100).toFixed(2));
}
function fmtDate(v, locale = "es-ES") {
    if (!v) return "";
    const d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
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
    const { t, locale } = useT();
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
    const [config, setConfig] = useState({ currencySymbol: "$", manualInstructions: "", notifyEmail: "", pendingHoldPercent: 50, pendingTtlMinutes: 20 });

    const flash = (msg) => { setMessage(msg); };

    // ── data loading ─────────────────────────────────────────────────────────────────────────────
    const loadEvents = async () => {
        try {
            const data = await api("/plugin/event-tickets/events");
            setEvents(data.events || []);
        } catch (err) {
            flash(t("msg.loadEvents", { msg: err?.message || err }));
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
            flash(t("msg.loadOrders", { msg: err?.message || err }));
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
            flash(t("msg.loadAttendees", { msg: err?.message || err }));
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
            flash(t("msg.eventSaved"));
        } catch (err) {
            flash(t("common.error", { msg: err?.message || err }));
        } finally { setBusy(false); }
    };
    const deleteEvent = async (ev) => {
        if (typeof window !== "undefined" && !window.confirm(t("confirm.deleteEvent", { title: ev.title }))) return;
        setBusy(true);
        try {
            await apiDelete(`/plugin/event-tickets/events/${ev.id}`);
            await loadEvents();
            flash(t("msg.eventDeleted"));
        } catch (err) {
            flash(t("common.error", { msg: err?.message || err }));
        } finally { setBusy(false); }
    };
    const saveType = async (e) => {
        e.preventDefault();
        if (!typeForm) return;
        const cents = priceToCents(typeForm.price === "" ? "0" : typeForm.price);
        if (cents === null) { flash(t("msg.badPrice")); return; }
        const capacity = parseInt(typeForm.capacity, 10);
        if (!isFinite(capacity) || capacity < 1) { flash(t("msg.badCapacity")); return; }
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
            flash(t("msg.typeSaved"));
        } catch (err) {
            flash(t("common.error", { msg: err?.message || err }));
        } finally { setBusy(false); }
    };
    const deleteType = async (tp) => {
        if (typeof window !== "undefined" && !window.confirm(t("confirm.deleteType", { name: tp.name }))) return;
        setBusy(true);
        try {
            await apiDelete(`/plugin/event-tickets/types/${tp.id}`);
            await loadEvents();
            flash(t("msg.typeDeleted"));
        } catch (err) {
            flash(t("common.error", { msg: err?.message || err }));
        } finally { setBusy(false); }
    };
    const toggleTypeActive = async (tp) => {
        try {
            await apiPut(`/plugin/event-tickets/types/${tp.id}`, { is_active: tp.is_active ? 0 : 1 });
            await loadEvents();
        } catch (err) {
            flash(t("common.error", { msg: err?.message || err }));
        }
    };

    // ── pedidos actions ──────────────────────────────────────────────────────────────────────────
    const confirmPaid = async (o) => {
        if (typeof window !== "undefined" && !window.confirm(t("confirm.paid", { buyer: o.buyer_name, amount: fmtMoney(o.total_cents, config.currencySymbol) }))) return;
        setBusy(true); setMessage("");
        try {
            const r = await apiPost(`/plugin/event-tickets/orders/${o.id}/paid`, {});
            const n = (r.tickets || []).length;
            flash(r.already ? t("msg.alreadyPaid") : (r.emailSent ? t("msg.paidMailed", { n }) : t("msg.paidNoMail", { n })));
            await loadOrders();
            await loadEvents();
        } catch (err) {
            flash(t("common.error", { msg: err?.message || err }));
        } finally { setBusy(false); }
    };
    const cancelOrder = async (o) => {
        if (typeof window !== "undefined" && !window.confirm(t("confirm.cancel", { buyer: o.buyer_name }))) return;
        setBusy(true); setMessage("");
        try {
            await apiPost(`/plugin/event-tickets/orders/${o.id}/cancel`, {});
            flash(t("msg.orderCancelled"));
            await loadOrders();
            await loadEvents();
        } catch (err) {
            flash(t("common.error", { msg: err?.message || err }));
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
            setCheckinResult({ kind: "invalid", error: err?.message || t("att.invalid") });
        } finally {
            setBusy(false);
            checkinInputRef.current?.focus();
        }
    };
    const undoCheckin = async (tk) => {
        try {
            await apiPost(`/plugin/event-tickets/tickets/${tk.id}/undo-checkin`, {});
            await loadAttendees();
        } catch (err) {
            flash(t("common.error", { msg: err?.message || err }));
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
            a.download = data.filename || t("csv.filename");
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            flash(t("msg.exportFailed", { msg: err?.message || err }));
        } finally { setBusy(false); }
    };

    // ── config actions ───────────────────────────────────────────────────────────────────────────
    const saveConfig = async (e) => {
        e.preventDefault();
        setBusy(true); setMessage("");
        try {
            const cfg = await apiPost("/plugin/event-tickets/config", config);
            setConfig(cfg);
            flash(t("msg.configSaved"));
        } catch (err) {
            flash(t("common.error", { msg: err?.message || err }));
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

    const isErrorMsg = /Erro|falló|no enviado|not sent|não enviado/i.test(message);

    return (
        <div className="cf-shell">
            {/* header: stamp + title + rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconTicket /></div>
                <div>
                    <h1 className="cf-title">{t("app.title")}</h1>
                    <p className="cf-subtitle">{t("app.subtitle")}</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* tabs */}
            <div className="cf-tabs" role="tablist">
                {tabBtn("eventos", t("tab.events"))}
                {tabBtn("pedidos", t("tab.orders"), pendingTotal)}
                {tabBtn("asistentes", t("tab.attendees"))}
                {tabBtn("config", t("tab.config"))}
            </div>

            {message && (
                <div role={isErrorMsg ? "alert" : "status"} className={`cf-flash ${isErrorMsg ? "is-error" : "is-ok"}`}>{message}</div>
            )}

            {/* ═══════════ EVENTOS ═══════════ */}
            {tab === "eventos" && (
                <div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
                        <button type="button" className="cf-btn" onClick={() => setEventForm({ ...EMPTY_EVENT })}><IconPlus /> {t("ev.new")}</button>
                    </div>

                    {eventForm && (
                        <form onSubmit={saveEvent} className="cf-editor">
                            <div className="cf-editor-body">
                                <h2 className="cf-editor-title"><IconPen /> {eventForm.id ? t("ev.edit") : t("ev.new")}</h2>
                                <div className="cf-grid">
                                    <div>
                                        <label className="cf-label" htmlFor="et-ev-title">{t("ev.title")}</label>
                                        <input id="et-ev-title" className="cf-input" value={eventForm.title} onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })} required />
                                    </div>
                                    <div>
                                        <label className="cf-label" htmlFor="et-ev-starts">{t("ev.startsAt")}</label>
                                        <input id="et-ev-starts" type="datetime-local" className="cf-input" value={eventForm.starts_at} onChange={(e) => setEventForm({ ...eventForm, starts_at: e.target.value })} required />
                                    </div>
                                    <div>
                                        <label className="cf-label" htmlFor="et-ev-venue">{t("ev.venue")}</label>
                                        <input id="et-ev-venue" className="cf-input" value={eventForm.venue} onChange={(e) => setEventForm({ ...eventForm, venue: e.target.value })} />
                                    </div>
                                    <div style={{ display: "flex", alignItems: "flex-end" }}>
                                        <label className="cf-check">
                                            <input type="checkbox" checked={!!eventForm.is_published} onChange={(e) => setEventForm({ ...eventForm, is_published: e.target.checked })} />
                                            {t("ev.published")}
                                        </label>
                                    </div>
                                    <div className="cf-span-2">
                                        <label className="cf-label" htmlFor="et-ev-desc">{t("ev.desc")}</label>
                                        <textarea id="et-ev-desc" className="cf-input" rows={3} value={eventForm.description} onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })} />
                                    </div>
                                </div>
                                <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}>
                                    <button type="button" className="cf-btn-ghost" onClick={() => setEventForm(null)}>{t("common.cancel")}</button>
                                    <button type="submit" className="cf-btn" disabled={busy}>{busy ? t("common.saving") : t("common.save")}</button>
                                </div>
                            </div>
                        </form>
                    )}

                    {events.length === 0 && !eventForm && (
                        <div className="cf-empty">
                            <IconCalendar />
                            <span>{t("ev.empty")}</span>
                        </div>
                    )}

                    {events.map((ev) => (
                        <div key={ev.id} className="cf-card-item">
                            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                                        <h3 className="cf-form-name">{ev.title}</h3>
                                        {!ev.is_published && <span className="cf-chip">{t("ev.draft")}</span>}
                                    </div>
                                    <p className="cf-meta">{fmtDate(ev.starts_at, locale)}{ev.venue ? ` · ${ev.venue}` : ""}</p>
                                </div>
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                                    <button type="button" className="cf-btn-ghost" onClick={() => setOpenEventId(openEventId === ev.id ? null : ev.id)}>
                                        <IconTicket /> {openEventId === ev.id ? t("ev.hideTypes") : t("ev.types", { count: (ev.types || []).length })}
                                    </button>
                                    <button type="button" className="cf-btn-ghost" onClick={() => setEventForm({ id: ev.id, title: ev.title, starts_at: ev.starts_at, venue: ev.venue || "", description: ev.description || "", is_published: !!ev.is_published })}><IconPen /> {t("common.edit")}</button>
                                    <button type="button" className="cf-btn-danger" onClick={() => deleteEvent(ev)}>{t("common.delete")}</button>
                                </div>
                            </div>

                            {openEventId === ev.id && (
                                <div className="cf-types">
                                    {(ev.types || []).map((tp) => {
                                        const cap = Number(tp.capacity) || 0;
                                        const sold = Number(tp.sold) || 0;
                                        const pct = cap > 0 ? Math.min(100, Math.round((sold / cap) * 100)) : 0;
                                        return (
                                            <div key={tp.id} className="cf-type-row">
                                                <div style={{ flex: 1, minWidth: "180px" }}>
                                                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                                                        <span className="cf-type-name">{tp.name}</span>
                                                        <span className="cf-type-price">{Number(tp.price_cents) > 0 ? fmtMoney(tp.price_cents, config.currencySymbol) : t("common.free")}</span>
                                                        {!tp.is_active && <span className="cf-chip">{t("tt.inactive")}</span>}
                                                        {tp.sales_end && <span className="cf-type-note" style={{ marginTop: 0 }}>{t("tt.salesUntil", { date: fmtDate(tp.sales_end, locale) })}</span>}
                                                    </div>
                                                    <div className="cf-meter" role="img" aria-label={t("tt.soldAria", { pct })}>
                                                        <div className={`cf-meter-fill ${pct >= 100 ? "is-full" : pct >= 80 ? "is-warn" : ""}`} style={{ width: `${pct}%` }} />
                                                    </div>
                                                    <p className="cf-type-note">{t("tt.soldNote", { sold, cap, left: Math.max(0, cap - sold) })}</p>
                                                </div>
                                                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                                                    <button type="button" className="cf-btn-ghost" onClick={() => toggleTypeActive(tp)}>{tp.is_active ? t("tt.deactivate") : t("tt.activate")}</button>
                                                    <button type="button" className="cf-btn-ghost" onClick={() => setTypeForm({ id: tp.id, event_id: ev.id, name: tp.name, price: String((Number(tp.price_cents) || 0) / 100), capacity: String(tp.capacity), sales_end: tp.sales_end || "", is_active: !!tp.is_active })}><IconPen /> {t("common.edit")}</button>
                                                    <button type="button" title={t("tt.deleteTitle")} aria-label={t("tt.deleteAria", { name: tp.name })} className="cf-iconbtn is-danger" onClick={() => deleteType(tp)}>×</button>
                                                </div>
                                            </div>
                                        );
                                    })}

                                    {typeForm && typeForm.event_id === ev.id ? (
                                        <form onSubmit={saveType} className="cf-type-editor">
                                            <div className="cf-type-grid">
                                                <div>
                                                    <label className="cf-label" htmlFor="et-tt-name">{t("tt.name")}</label>
                                                    <input id="et-tt-name" className="cf-input" value={typeForm.name} onChange={(e) => setTypeForm({ ...typeForm, name: e.target.value })} placeholder={t("tt.namePh")} required />
                                                </div>
                                                <div>
                                                    <label className="cf-label" htmlFor="et-tt-price">{t("tt.price", { symbol: config.currencySymbol })}</label>
                                                    <input id="et-tt-price" className="cf-input" value={typeForm.price} onChange={(e) => setTypeForm({ ...typeForm, price: e.target.value })} placeholder={t("tt.pricePh")} inputMode="decimal" />
                                                </div>
                                                <div>
                                                    <label className="cf-label" htmlFor="et-tt-cap">{t("tt.capacity")}</label>
                                                    <input id="et-tt-cap" type="number" min={1} className="cf-input" value={typeForm.capacity} onChange={(e) => setTypeForm({ ...typeForm, capacity: e.target.value })} required />
                                                </div>
                                                <div>
                                                    <label className="cf-label" htmlFor="et-tt-end">{t("tt.salesEnd")}</label>
                                                    <input id="et-tt-end" type="datetime-local" className="cf-input" value={typeForm.sales_end} onChange={(e) => setTypeForm({ ...typeForm, sales_end: e.target.value })} />
                                                </div>
                                                <div className="cf-span-full" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
                                                    <label className="cf-check">
                                                        <input type="checkbox" checked={!!typeForm.is_active} onChange={(e) => setTypeForm({ ...typeForm, is_active: e.target.checked })} />
                                                        {t("tt.active")}
                                                    </label>
                                                    <div style={{ display: "flex", gap: "0.5rem" }}>
                                                        <button type="button" className="cf-btn-ghost" onClick={() => setTypeForm(null)}>{t("common.cancel")}</button>
                                                        <button type="submit" className="cf-btn" disabled={busy}>{t("tt.save")}</button>
                                                    </div>
                                                </div>
                                            </div>
                                        </form>
                                    ) : (
                                        <div>
                                            <button type="button" className="cf-btn-ghost" onClick={() => setTypeForm({ event_id: ev.id, ...EMPTY_TYPE })}><IconPlus /> {t("tt.add")}</button>
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
                            <select className="cf-select" aria-label={t("common.filterEvent")} value={orderEventFilter} onChange={(e) => { setOrderEventFilter(e.target.value); loadOrders(e.target.value, orderStatusFilter); }}>
                                <option value="">{t("common.allEvents")}</option>
                                {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.title}</option>)}
                            </select>
                            <select className="cf-select" aria-label={t("ord.filterStatus")} value={orderStatusFilter} onChange={(e) => { setOrderStatusFilter(e.target.value); loadOrders(orderEventFilter, e.target.value); }}>
                                <option value="">{t("ord.allStatuses")}</option>
                                <option value="pending">{t("ord.pending")}</option>
                                <option value="paid">{t("ord.paid")}</option>
                                <option value="cancelled">{t("ord.cancelled")}</option>
                            </select>
                        </div>
                    </div>

                    {orders.length === 0 ? (
                        <div className="cf-empty">
                            <IconTicket />
                            <span>{t("ord.empty")}</span>
                        </div>
                    ) : (
                        <div className="cf-table-wrap">
                            <table className="cf-table">
                                <thead>
                                    <tr>
                                        <th>{t("ord.col.buyer")}</th>
                                        <th>{t("ord.col.event")}</th>
                                        <th>{t("ord.col.tickets")}</th>
                                        <th>{t("ord.col.total")}</th>
                                        <th>{t("ord.col.status")}</th>
                                        <th>{t("ord.col.date")}</th>
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
                                                    {o.payment_status === "paid" ? t("ord.paid") : o.payment_status === "pending" ? t("ord.pending") : o.payment_status === "unverified" || o.payment_status === "verifying" ? t("ord.unverified") : o.payment_status === "expired" ? t("ord.expired") : t("ord.cancelled")}
                                                </span>
                                            </td>
                                            <td className="cf-cell-date">{fmtDate(o.created_at, locale)}</td>
                                            <td>
                                                <div className="cf-cell-actions">
                                                    {o.payment_status === "pending" && (
                                                        <button type="button" className="cf-btn" disabled={busy} onClick={() => confirmPaid(o)}><IconCheck /> {t("ord.confirmPaid")}</button>
                                                    )}
                                                    {o.payment_status !== "cancelled" && (
                                                        <button type="button" className="cf-btn-danger" disabled={busy} onClick={() => cancelOrder(o)}>{t("ord.cancel")}</button>
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
                            <h2 className="cf-editor-title"><IconCheck /> {t("att.checkinTitle")}</h2>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
                                <input
                                    ref={checkinInputRef}
                                    id="et-checkin"
                                    aria-label={t("att.codeAria")}
                                    className="cf-input cf-code-input"
                                    style={{ flex: 1, minWidth: "220px", width: "auto" }}
                                    value={checkinCode}
                                    onChange={(e) => setCheckinCode(e.target.value.toUpperCase())}
                                    placeholder={t("att.codePh")}
                                    autoComplete="off"
                                />
                                <button type="submit" className="cf-btn" disabled={busy || !checkinCode.trim()}>{t("att.register")}</button>
                            </div>
                            {checkinResult && checkinResult.kind === "ok" && (
                                <div className="cf-checkin is-ok" role="status">
                                    <IconCheck />
                                    <div>
                                        {checkinResult.attendee} — {checkinResult.type || t("att.ticket")}
                                        {checkinResult.event ? <span className="cf-checkin-sub">{checkinResult.event}</span> : null}
                                    </div>
                                </div>
                            )}
                            {checkinResult && checkinResult.kind === "already" && (
                                <div className="cf-checkin is-warn" role="status">
                                    <IconTicket />
                                    <div>{t("att.already", { at: fmtDate(checkinResult.at, locale), attendee: checkinResult.attendee })}</div>
                                </div>
                            )}
                            {checkinResult && checkinResult.kind === "invalid" && (
                                <div className="cf-checkin is-error" role="alert">
                                    <IconX />
                                    <div>{checkinResult.error || t("att.invalid")}</div>
                                </div>
                            )}
                        </div>
                    </form>

                    <div className="cf-card-item">
                        <div className="cf-toolbar">
                            <div className="cf-toolbar-left" style={{ flex: 1 }}>
                                <select className="cf-select" aria-label={t("common.filterEvent")} value={attEventFilter} onChange={(e) => { setAttEventFilter(e.target.value); loadAttendees(e.target.value, attSearch); }}>
                                    <option value="">{t("common.allEvents")}</option>
                                    {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.title}</option>)}
                                </select>
                                <input
                                    className="cf-input"
                                    aria-label={t("att.searchAria")}
                                    style={{ flex: 1, minWidth: "200px", width: "auto" }}
                                    value={attSearch}
                                    onChange={(e) => setAttSearch(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); loadAttendees(attEventFilter, attSearch); } }}
                                    placeholder={t("att.searchPh")}
                                />
                                <button type="button" className="cf-btn-ghost" onClick={() => loadAttendees(attEventFilter, attSearch)}><IconSearch /> {t("att.search")}</button>
                            </div>
                            <button type="button" className="cf-btn" onClick={exportCsv} disabled={busy}><IconDownload /> {t("common.exportCsv")}</button>
                        </div>

                        {attendees.length === 0 ? (
                            <div className="cf-empty">
                                <IconUsers />
                                <span>{t("att.empty")}</span>
                            </div>
                        ) : (
                            <div className="cf-table-wrap">
                                <table className="cf-table">
                                    <thead>
                                        <tr>
                                            <th>{t("att.col.code")}</th>
                                            <th>{t("att.col.attendee")}</th>
                                            <th>{t("att.col.type")}</th>
                                            <th>{t("att.col.event")}</th>
                                            <th>{t("att.col.checkin")}</th>
                                            <th></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {attendees.map((tk) => (
                                            <tr key={tk.id} className="cf-row-static">
                                                <td className="cf-cell-code">{tk.code}</td>
                                                <td>
                                                    <div className="cf-cell-main">{tk.attendee_name || tk.buyer_name}</div>
                                                    <div className="cf-cell-sub">{tk.buyer_email}</div>
                                                </td>
                                                <td>{tk.type_name || "—"}</td>
                                                <td>{tk.event_title || "—"}</td>
                                                <td>
                                                    {tk.checked_in_at
                                                        ? <span className="cf-checked"><IconCheck /> {fmtDate(tk.checked_in_at, locale)}</span>
                                                        : <span className="cf-void">—</span>}
                                                </td>
                                                <td style={{ textAlign: "right" }}>
                                                    {tk.checked_in_at && (
                                                        <button type="button" className="cf-btn-ghost" onClick={() => undoCheckin(tk)}>{t("att.undo")}</button>
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
                        <h2 className="cf-editor-title"><IconSliders /> {t("cfg.title")}</h2>
                        <div className="cf-grid">
                            <div>
                                <label className="cf-label" htmlFor="et-cfg-symbol">{t("cfg.currency")}</label>
                                <input id="et-cfg-symbol" className="cf-input" value={config.currencySymbol} onChange={(e) => setConfig({ ...config, currencySymbol: e.target.value })} placeholder="$" />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="et-cfg-notify">{t("cfg.notify")}</label>
                                <input id="et-cfg-notify" type="email" className="cf-input" value={config.notifyEmail} onChange={(e) => setConfig({ ...config, notifyEmail: e.target.value })} placeholder={t("cfg.notifyPh")} />
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="et-cfg-hold">{t("cfg.hold")}</label>
                                <input id="et-cfg-hold" type="number" min={1} max={100} className="cf-input" value={config.pendingHoldPercent} onChange={(e) => setConfig({ ...config, pendingHoldPercent: Number(e.target.value) })} />
                                <p className="cf-help">{t("cfg.holdHelp")}</p>
                            </div>
                            <div>
                                <label className="cf-label" htmlFor="et-cfg-ttl">{t("cfg.ttl")}</label>
                                <input id="et-cfg-ttl" type="number" min={5} max={1440} className="cf-input" value={config.pendingTtlMinutes} onChange={(e) => setConfig({ ...config, pendingTtlMinutes: Number(e.target.value) })} />
                                <p className="cf-help">{t("cfg.ttlHelp")}</p>
                            </div>
                            <div className="cf-span-2">
                                <label className="cf-label" htmlFor="et-cfg-instr">{t("cfg.instr")}</label>
                                <textarea id="et-cfg-instr" className="cf-input" rows={4} value={config.manualInstructions} onChange={(e) => setConfig({ ...config, manualInstructions: e.target.value })} placeholder={t("cfg.instrPh")} />
                                <p className="cf-help">{t("cfg.instrHelp")}</p>
                            </div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1.5rem" }}>
                            <button type="submit" className="cf-btn" disabled={busy}>{busy ? t("common.saving") : t("common.save")}</button>
                        </div>
                    </div>
                </form>
            )}
        </div>
    );
}
