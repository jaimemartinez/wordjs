// @ts-nocheck
"use client";

/**
 * Admin page for the Bookings plugin (/admin/plugin/bookings).
 * Tabs: Agenda (day/week list grouped by day, colored by service, status changes, CSV export),
 * Servicios (CRUD modal with a per-weekday availability editor), Configuración (notification
 * email + minimum notice hours). All calls go through the host api helpers (session cookie).
 *
 * Visual identity (shared premium admin look) lives in the plugin's OWN stylesheet
 * (client/admin/admin.css, injected by the host admin shell and scoped to
 * .plugin-admin-bookings) — the markup below only uses cf-* classes.
 */

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, apiPost, apiPut, apiDelete } from "@/lib/api";
import { useT } from "./i18n";

const BASE = "/plugin/bookings";

const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
// Labels are looked up through `t` at render time so they follow the admin's language.
const dayLabel = (t, day) => t(`day.${day}`);
const statusLabel = (t, status) => {
    const key = `status.${status}`;
    const s = t(key);
    return s === key ? undefined : s;
};
const STATUS_BADGE = {
    confirmed: "is-confirmed",
    cancelled: "is-cancelled",
    completed: "is-completed",
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
const prettyDate = (t, s) => {
    const d = fromDateStr(s);
    return t("date.pretty", { dow: t(`dow.${d.getDay()}`), d: d.getDate(), m: pad2(d.getMonth() + 1), y: d.getFullYear() });
};
const fmtPrice = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

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
const IconDownload = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="m7 10 5 5 5-5" />
        <path d="M12 15V3" />
    </svg>
);
const IconChevronLeft = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="m15 18-6-6 6-6" />
    </svg>
);
const IconChevronRight = (props) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        <path d="m9 18 6-6-6-6" />
    </svg>
);

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
    const { t } = useT();
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
            setError(err?.message || t("svc.saveError"));
        } finally {
            setBusy(false);
        }
    };

    // Portalled to <body> (inside the plugin's scope class, so its styles still apply): rendered in place,
    // the admin sidebar covered the modal's left edge and clipped its labels (X4-13).
    const node = (
        <div className="plugin-admin-bookings" style={{ background: "transparent", minHeight: 0 }}>
        <div className="cf-overlay" onClick={onClose}>
            <form
                onSubmit={save}
                className="cf-letter is-wide"
                role="dialog"
                aria-modal="true"
                aria-label={service ? t("svc.edit") : t("svc.new")}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="cf-letter-body">
                    <h2 className="cf-editor-title">
                        <IconPen />
                        {service ? t("svc.edit") : t("svc.new")}
                    </h2>

                    <div className="cf-grid">
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="bk-svc-name">{t("svc.name")}</label>
                            <input id="bk-svc-name" type="text" className="cf-input" value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                        </div>
                        <div className="cf-span-2">
                            <label className="cf-label" htmlFor="bk-svc-desc">{t("svc.description")}</label>
                            <textarea id="bk-svc-desc" className="cf-input" rows={2} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="bk-svc-duration">{t("svc.duration")}</label>
                            <input id="bk-svc-duration" type="number" className="cf-input" min={5} max={480} value={form.duration_min} onChange={(e) => setForm({ ...form, duration_min: e.target.value })} required />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="bk-svc-price">{t("svc.price")}</label>
                            <input id="bk-svc-price" type="text" inputMode="decimal" className="cf-input" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="0.00" />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="bk-svc-color">{t("svc.color")}</label>
                            <input id="bk-svc-color" type="color" className="cf-color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />
                        </div>
                        <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: "0.35rem" }}>
                            <label className="cf-check">
                                <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                                {t("svc.activePublic")}
                            </label>
                        </div>
                    </div>

                    <div style={{ marginTop: "1.5rem" }}>
                        <span className="cf-label">{t("svc.availability")}</span>
                        <p className="cf-help" style={{ marginTop: 0, marginBottom: "0.9rem" }}>
                            {t("svc.availabilityHelp", { min: form.duration_min || 60 })}
                        </p>
                        <div>
                            {DAY_ORDER.map((day) => {
                                const ranges = form.availability[day] || [];
                                return (
                                    <div key={day} className="cf-avail-row">
                                        <div className="cf-avail-day">{dayLabel(t, day)}</div>
                                        <div className="cf-avail-ranges">
                                            {ranges.length === 0 && <div className="cf-avail-closed">{t("svc.closed")}</div>}
                                            {ranges.map((r, idx) => (
                                                <div key={idx} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                                    <input type="time" aria-label={t("svc.rangeStart", { day: dayLabel(t, day) })} className="cf-input is-time" value={r.start} onChange={(e) => updateRange(day, idx, "start", e.target.value)} required />
                                                    <span className="cf-avail-arrow" aria-hidden="true">→</span>
                                                    <input type="time" aria-label={t("svc.rangeEnd", { day: dayLabel(t, day) })} className="cf-input is-time" value={r.end} onChange={(e) => updateRange(day, idx, "end", e.target.value)} required />
                                                    <button type="button" onClick={() => removeRange(day, idx)} className="cf-iconbtn is-danger" title={t("svc.removeRange")} aria-label={t("svc.removeRange")}>×</button>
                                                </div>
                                            ))}
                                        </div>
                                        <button type="button" onClick={() => addRange(day)} className="cf-btn-ghost"><IconPlus /> {t("svc.addRange")}</button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {error && <div role="alert" className="cf-flash is-error" style={{ marginTop: "1.25rem", marginBottom: 0 }}>{error}</div>}

                    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "0.75rem", marginTop: "1.5rem" }}>
                        <button type="button" onClick={onClose} className="cf-btn-ghost">{t("common.cancel")}</button>
                        <button type="submit" disabled={busy} className="cf-btn">{busy ? t("common.saving") : t("common.save")}</button>
                    </div>
                </div>
            </form>
        </div>
        </div>
    );
    return typeof document !== "undefined" && document.body ? createPortal(node, document.body) : node;
}

// ── main page ───────────────────────────────────────────────────────────────────────────────────

export default function BookingsAdminPage() {
    const { t } = useT();
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
            setAgendaMsg(t("agenda.loadError", { msg: err?.message || err }));
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
            setAgendaMsg(t("agenda.statusError", { msg: err?.message || err }));
        }
    };

    const deleteBooking = async (id) => {
        if (typeof window !== "undefined" && !window.confirm(t("agenda.confirmDelete"))) return;
        setAgendaMsg("");
        try {
            await apiDelete(`${BASE}/bookings/${id}`);
            loadBookings();
        } catch (err) {
            setAgendaMsg(t("agenda.deleteError", { msg: err?.message || err }));
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
            a.download = data.filename || t("agenda.csvName");
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            setAgendaMsg(t("agenda.exportError", { msg: err?.message || err }));
        }
    };

    const deleteService = async (svc) => {
        if (typeof window !== "undefined" && !window.confirm(t("services.confirmDelete", { name: svc.name }))) return;
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
            setConfigMsg(t("config.saved"));
        } catch (err) {
            setConfigMsg(t("common.error", { msg: err?.message || err }));
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
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`cf-tab ${tab === id ? "is-active" : ""}`}
        >
            {label}
        </button>
    );

    return (
        <div className="cf-shell">
            {/* header: stamp + title + rule */}
            <div className="cf-header">
                <div className="cf-stamp" aria-hidden="true"><IconCalendar /></div>
                <div>
                    <h1 className="cf-title">{t("app.title")}</h1>
                    <p className="cf-subtitle">{t("app.subtitle")}</p>
                </div>
            </div>
            <div className="cf-airmail-rule" aria-hidden="true"></div>

            {/* tabs */}
            <div className="cf-tabs" role="tablist">
                {tabBtn("agenda", t("tab.agenda"))}
                {tabBtn("servicios", t("tab.services"))}
                {tabBtn("config", t("tab.config"))}
            </div>

            {/* ══════════ AGENDA ══════════ */}
            {tab === "agenda" && (
                <div className="cf-card-item">
                    <div className="cf-toolbar">
                        <div className="cf-toolbar-left">
                            <div className="cf-seg" role="group" aria-label={t("agenda.view")}>
                                <button type="button" onClick={() => setViewMode("day")} className={`cf-seg-btn ${viewMode === "day" ? "is-active" : ""}`}>{t("agenda.day")}</button>
                                <button type="button" onClick={() => setViewMode("week")} className={`cf-seg-btn ${viewMode === "week" ? "is-active" : ""}`}>{t("agenda.week")}</button>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", flexWrap: "wrap" }}>
                                <button type="button" aria-label={t("agenda.prev")} title={t("agenda.prev")} onClick={() => setAnchor(addDays(anchor, viewMode === "day" ? -1 : -7))} className="cf-iconbtn"><IconChevronLeft /></button>
                                <input type="date" aria-label={t("agenda.date")} className="cf-input is-date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)} />
                                <button type="button" aria-label={t("agenda.next")} title={t("agenda.next")} onClick={() => setAnchor(addDays(anchor, viewMode === "day" ? 1 : 7))} className="cf-iconbtn"><IconChevronRight /></button>
                                <button type="button" onClick={() => setAnchor(toDateStr(new Date()))} className="cf-btn-ghost">{t("agenda.today")}</button>
                            </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                            <select aria-label={t("agenda.filterStatus")} className="cf-select is-compact" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                                <option value="">{t("agenda.allStatuses")}</option>
                                <option value="pending">{t("agenda.fPending")}</option>
                                <option value="confirmed">{t("agenda.fConfirmed")}</option>
                                <option value="completed">{t("agenda.fCompleted")}</option>
                                <option value="cancelled">{t("agenda.fCancelled")}</option>
                                <option value="expired">{t("agenda.fExpired")}</option>
                            </select>
                            <select aria-label={t("agenda.filterService")} className="cf-select is-compact" value={serviceFilter} onChange={(e) => setServiceFilter(e.target.value)}>
                                <option value="">{t("agenda.allServices")}</option>
                                {(services || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                            <button type="button" onClick={exportCsv} className="cf-btn-ghost"><IconDownload /> {t("agenda.exportCsv")}</button>
                        </div>
                    </div>

                    <p className="cf-range-label">
                        {rangeFrom === rangeTo ? prettyDate(t, rangeFrom) : `${prettyDate(t, rangeFrom)} — ${prettyDate(t, rangeTo)}`}
                    </p>

                    {agendaMsg && <div role="alert" className="cf-flash is-error">{agendaMsg}</div>}

                    {bookings === null ? (
                        <p className="cf-help">{t("agenda.loading")}</p>
                    ) : grouped.length === 0 ? (
                        <div className="cf-empty">
                            <IconCalendar />
                            <span>{t("agenda.empty")}</span>
                        </div>
                    ) : (
                        <div>
                            {grouped.map((g) => (
                                <div key={g.date} className="cf-agenda-day">
                                    <h3 className="cf-day-head">{prettyDate(t, g.date)}</h3>
                                    <div>
                                        {g.items.map((b) => (
                                            <div key={b.id} className="cf-rowcard" style={{ borderLeftColor: b.service_color || "#3b82f6" }}>
                                                <div className="cf-booking-time">{b.time}</div>
                                                <div style={{ minWidth: "140px" }}>
                                                    <div className="cf-row-name">{b.service_name || t("agenda.deletedService")}</div>
                                                    <div className="cf-row-sub">{b.duration_min ? t("agenda.minutes", { n: b.duration_min }) : ""}</div>
                                                </div>
                                                <div style={{ flex: 1, minWidth: "180px" }}>
                                                    <div className="cf-row-name">{b.customer_name}</div>
                                                    <div className="cf-row-sub">
                                                        {b.customer_email}{b.customer_phone ? ` · ${b.customer_phone}` : ""}
                                                    </div>
                                                    {b.notes ? <div className="cf-row-notes">“{b.notes}”</div> : null}
                                                </div>
                                                <span className={`cf-pill ${STATUS_BADGE[b.status] || "is-muted"}`}>
                                                    {statusLabel(t, b.status) || b.status}
                                                </span>
                                                <select
                                                    aria-label={t("agenda.changeStatus")}
                                                    className="cf-select is-compact"
                                                    value={b.status}
                                                    onChange={(e) => changeStatus(b.id, e.target.value)}
                                                >
                                                    {b.status === "pending" || b.status === "expired" ? (
                                                        <option value={b.status} disabled>{statusLabel(t, b.status)}</option>
                                                    ) : null}
                                                    <option value="confirmed">{t("status.confirmed")}</option>
                                                    <option value="completed">{t("status.completed")}</option>
                                                    <option value="cancelled">{t("status.cancelled")}</option>
                                                </select>
                                                <button type="button" onClick={() => deleteBooking(b.id)} className="cf-iconbtn is-danger" title={t("common.delete")} aria-label={t("common.delete")}>×</button>
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
                <div className="cf-card-item">
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1.25rem" }}>
                        <h2 className="cf-section-title">{t("services.title")}</h2>
                        <button type="button" onClick={() => setModalService(null)} className="cf-btn"><IconPlus /> {t("services.new")}</button>
                    </div>

                    {servicesMsg && <div role="alert" className="cf-flash is-error">{servicesMsg}</div>}

                    {services === null ? (
                        <p className="cf-help">{t("services.loading")}</p>
                    ) : services.length === 0 ? (
                        <div className="cf-empty">
                            <IconCalendar />
                            <span>{t("services.empty")}</span>
                        </div>
                    ) : (
                        <div>
                            {services.map((s) => {
                                const days = DAY_ORDER.filter((d) => (s.availability && s.availability[d] || []).length > 0);
                                return (
                                    <div key={s.id} className="cf-rowcard" style={{ borderLeftColor: s.color || "#3b82f6" }}>
                                        <div style={{ flex: 1, minWidth: "180px" }}>
                                            <div className="cf-row-name">{s.name} {!s.is_active && <span className="cf-pill is-muted" style={{ marginLeft: "0.35rem" }}>{t("services.inactive")}</span>}</div>
                                            <div className="cf-row-sub">
                                                {s.duration_min} min · {Number(s.price_cents) > 0 ? fmtPrice(s.price_cents) : t("services.free")} ·
                                                {days.length ? ` ${days.map((d) => dayLabel(t, d).slice(0, 3)).join(", ")}` : t("services.noAvailability")}
                                            </div>
                                        </div>
                                        <button type="button" onClick={() => toggleService(s)} className="cf-btn-ghost">{s.is_active ? t("services.deactivate") : t("services.activate")}</button>
                                        <button type="button" onClick={() => setModalService(s)} className="cf-btn-ghost"><IconPen /> {t("common.edit")}</button>
                                        <button type="button" onClick={() => deleteService(s)} className="cf-btn-danger">{t("common.delete")}</button>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <p className="cf-help" style={{ marginTop: "1.4rem" }}>
                        {t("services.usage1")}<strong>Bookings</strong>{t("services.usage2")}
                    </p>
                </div>
            )}

            {/* ══════════ CONFIGURACIÓN ══════════ */}
            {tab === "config" && (
                <form onSubmit={saveConfig} className="cf-card-item" style={{ maxWidth: "36rem" }}>
                    <h2 className="cf-section-title" style={{ marginBottom: "1.25rem" }}>{t("config.title")}</h2>
                    <div style={{ display: "grid", gap: "1.05rem" }}>
                        <div>
                            <label className="cf-label" htmlFor="bk-cfg-email">{t("config.notifyEmail")}</label>
                            <input id="bk-cfg-email" type="email" className="cf-input" value={config.notifyEmail} placeholder={t("config.notifyPlaceholder")} onChange={(e) => setConfig({ ...config, notifyEmail: e.target.value })} />
                        </div>
                        <div>
                            <label className="cf-label" htmlFor="bk-cfg-notice">{t("config.minNotice")}</label>
                            <input id="bk-cfg-notice" type="number" min={0} max={720} className="cf-input" value={config.minNoticeHours} onChange={(e) => setConfig({ ...config, minNoticeHours: e.target.value })} />
                            <p className="cf-help">
                                {t("config.minNoticeHelp")}
                            </p>
                        </div>
                        {configMsg && <div role={/^Erro/.test(configMsg) ? "alert" : "status"} className={`cf-flash ${/^Erro/.test(configMsg) ? "is-error" : "is-ok"}`} style={{ marginBottom: 0 }}>{configMsg}</div>}
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                            <button type="submit" disabled={configBusy} className="cf-btn">{configBusy ? t("common.saving") : t("common.save")}</button>
                        </div>
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
