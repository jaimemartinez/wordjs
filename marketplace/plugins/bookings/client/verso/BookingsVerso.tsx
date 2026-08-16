// @ts-nocheck
"use client";

/**
 * Verso block "Bookings" — public booking wizard.
 *
 * Flow: (1) service cards (or a preselected service via serviceId), (2) date picker (30-day
 * strip + native date input), (3) slot chips from /public/slots, (4) customer form with
 * honeypot + elapsed anti-spam, (5) success view showing the reservation token.
 * Also: on mount it handles ?booking=<token> (and a manual code input) to show the reservation
 * status with a cancel button.
 *
 * Runs in the editor iframe AND the public page: all data comes from the plugin's PUBLIC
 * endpoints with res.ok guards — an inactive plugin degrades to a quiet Spanish placeholder.
 */

import React, { useEffect, useRef, useState } from "react";

const API = "/api/v1/plugin/bookings";

const STYLES = `
.wjbk-root { --wjbk-a: #3b82f6; font-family: var(--wjs-font-family-base, inherit); color: var(--wjs-color-text, #111827); max-width: 100%; }
.wjbk-card { background: var(--wjs-bg-surface, #fff); border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 12px); padding: 1.25rem; }
.wjbk-empty { padding: 2rem 1rem; text-align: center; color: var(--wjs-color-text-muted, #6b7280); background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #e5e7eb); border-radius: var(--wjs-radius, 12px); font-size: .9rem; }
.wjbk-title { font-weight: 700; font-size: 1.05rem; margin: 0 0 .75rem; }
.wjbk-sub { font-size: .85rem; color: var(--wjs-color-text-muted, #6b7280); margin: 0 0 1rem; }
.wjbk-services { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: .75rem; }
.wjbk-svc { text-align: left; cursor: pointer; background: var(--wjs-bg-surface, #fff); border: 2px solid var(--wjs-border-subtle, #e5e7eb); border-radius: 12px; padding: .9rem 1rem; transition: border-color .15s, transform .15s; }
.wjbk-svc:hover { border-color: var(--wjbk-a); transform: translateY(-1px); }
.wjbk-svc.wjbk-sel { border-color: var(--wjbk-a); box-shadow: 0 0 0 3px color-mix(in srgb, var(--wjbk-a) 20%, transparent); }
.wjbk-svc-name { font-weight: 700; display: flex; align-items: center; gap: .5rem; }
.wjbk-dot { width: 10px; height: 10px; border-radius: 50%; flex: 0 0 10px; }
.wjbk-svc-meta { font-size: .8rem; color: var(--wjs-color-text-muted, #6b7280); margin-top: .25rem; }
.wjbk-svc-desc { font-size: .82rem; color: var(--wjs-color-text-muted, #6b7280); margin-top: .35rem; }
.wjbk-days { display: flex; gap: .5rem; overflow-x: auto; padding: .25rem 0 .5rem; scrollbar-width: thin; }
.wjbk-day { flex: 0 0 auto; min-width: 58px; cursor: pointer; text-align: center; border: 2px solid var(--wjs-border-subtle, #e5e7eb); background: var(--wjs-bg-surface, #fff); border-radius: 10px; padding: .45rem .35rem; }
.wjbk-day:hover { border-color: var(--wjbk-a); }
.wjbk-day.wjbk-sel { border-color: var(--wjbk-a); background: var(--wjbk-a); color: #fff; }
.wjbk-day-dow { font-size: .65rem; text-transform: uppercase; letter-spacing: .05em; opacity: .75; }
.wjbk-day-num { font-weight: 800; font-size: 1.05rem; line-height: 1.2; }
.wjbk-day-mon { font-size: .65rem; opacity: .75; }
.wjbk-slots { display: flex; flex-wrap: wrap; gap: .5rem; }
.wjbk-slot { cursor: pointer; border: 2px solid var(--wjs-border-subtle, #e5e7eb); background: var(--wjs-bg-surface, #fff); border-radius: 999px; padding: .4rem .9rem; font-weight: 600; font-size: .9rem; font-variant-numeric: tabular-nums; }
.wjbk-slot:hover { border-color: var(--wjbk-a); }
.wjbk-slot.wjbk-sel { border-color: var(--wjbk-a); background: var(--wjbk-a); color: #fff; }
.wjbk-form { display: grid; gap: .75rem; margin-top: 1rem; }
.wjbk-label { font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--wjs-color-text-muted, #6b7280); display: block; margin-bottom: .25rem; }
.wjbk-input, .wjbk-textarea { width: 100%; box-sizing: border-box; border: 2px solid var(--wjs-border-subtle, #e5e7eb); border-radius: 10px; padding: .55rem .75rem; font: inherit; background: var(--wjs-bg-surface, #fff); color: inherit; }
.wjbk-input:focus, .wjbk-textarea:focus { outline: none; border-color: var(--wjbk-a); }
.wjbk-btn { cursor: pointer; border: none; border-radius: 10px; padding: .65rem 1.25rem; font-weight: 700; font-size: .95rem; background: var(--wjbk-a); color: #fff; }
.wjbk-btn:disabled { opacity: .55; cursor: not-allowed; }
.wjbk-btn-ghost { cursor: pointer; background: transparent; border: none; color: var(--wjbk-a); font-weight: 600; font-size: .85rem; padding: .35rem .5rem; }
.wjbk-error { background: #fef2f2; color: #b91c1c; border-radius: 10px; padding: .6rem .9rem; font-size: .88rem; }
.wjbk-ok { background: #f0fdf4; color: #15803d; border-radius: 10px; padding: .6rem .9rem; font-size: .88rem; }
.wjbk-token { font-family: monospace; font-size: 1.15rem; letter-spacing: 2px; background: var(--wjs-bg-surface, #f9fafb); border: 1px dashed var(--wjs-border-subtle, #d1d5db); border-radius: 10px; padding: .6rem .9rem; word-break: break-all; text-align: center; margin: .5rem 0; user-select: all; }
.wjbk-hp { position: absolute; left: -9999px; top: -9999px; height: 1px; width: 1px; overflow: hidden; }
.wjbk-status-badge { display: inline-block; border-radius: 999px; padding: .2rem .7rem; font-size: .75rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
.wjbk-st-confirmed { background: #dcfce7; color: #15803d; }
.wjbk-st-cancelled { background: #fee2e2; color: #b91c1c; }
.wjbk-st-completed { background: #dbeafe; color: #1d4ed8; }
.wjbk-summary { font-size: .9rem; background: var(--wjs-bg-surface, #f9fafb); border: 1px solid var(--wjs-border-subtle, #e5e7eb); border-radius: 10px; padding: .6rem .9rem; margin: .75rem 0; }
.wjbk-row { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; }
@media (max-width: 480px) { .wjbk-services { grid-template-columns: 1fr; } }
`;

const DOW = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MON = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const STATUS_ES = { confirmed: "Confirmada", cancelled: "Cancelada", completed: "Completada" };

const pad2 = (n) => String(n).padStart(2, "0");
const dateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fmtPrice = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;
const nextDays = (n) => {
    const out = [];
    const base = new Date();
    for (let i = 0; i < n; i++) {
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
        out.push(d);
    }
    return out;
};

// ── module-level sub-components (NEVER define a component inside a component) ──────────────────

function ServicePicker({ services, selectedId, onPick }) {
    return (
        <div className="wjbk-services">
            {services.map((s) => (
                <button key={s.id} type="button" className={`wjbk-svc${s.id === selectedId ? " wjbk-sel" : ""}`} onClick={() => onPick(s)}>
                    <span className="wjbk-svc-name">
                        <span className="wjbk-dot" style={{ background: s.color || "#3b82f6" }}></span>
                        {s.name}
                    </span>
                    <div className="wjbk-svc-meta">
                        {s.duration_min} min{Number(s.price_cents) > 0 ? ` · ${fmtPrice(s.price_cents)}` : ""}
                    </div>
                    {s.description ? <div className="wjbk-svc-desc">{s.description}</div> : null}
                </button>
            ))}
        </div>
    );
}

function DayStrip({ days, selected, onPick }) {
    return (
        <div className="wjbk-days">
            {days.map((d) => {
                const ds = dateStr(d);
                return (
                    <button key={ds} type="button" className={`wjbk-day${ds === selected ? " wjbk-sel" : ""}`} onClick={() => onPick(ds)}>
                        <div className="wjbk-day-dow">{DOW[d.getDay()]}</div>
                        <div className="wjbk-day-num">{d.getDate()}</div>
                        <div className="wjbk-day-mon">{MON[d.getMonth()]}</div>
                    </button>
                );
            })}
        </div>
    );
}

function StatusView({ booking, cancelBusy, cancelMsg, onCancel, onClose }) {
    return (
        <div className="wjbk-card">
            <p className="wjbk-title">Tu reserva</p>
            <div className="wjbk-summary">
                <div><strong>{booking.service_name}</strong>{booking.duration_min ? ` · ${booking.duration_min} min` : ""}</div>
                <div>{booking.date} a las {booking.time}</div>
                <div>A nombre de: {booking.customer_name}</div>
                <div style={{ marginTop: "0.4rem" }}>
                    <span className={`wjbk-status-badge wjbk-st-${booking.status}`}>{STATUS_ES[booking.status] || booking.status}</span>
                </div>
            </div>
            {cancelMsg ? <div className={cancelMsg.ok ? "wjbk-ok" : "wjbk-error"}>{cancelMsg.text}</div> : null}
            <div className="wjbk-row" style={{ marginTop: "0.75rem" }}>
                {booking.canCancel ? (
                    <button type="button" className="wjbk-btn" style={{ background: "#dc2626" }} disabled={cancelBusy} onClick={onCancel}>
                        {cancelBusy ? "Cancelando…" : "Cancelar reserva"}
                    </button>
                ) : booking.status === "confirmed" ? (
                    <span className="wjbk-sub" style={{ margin: 0 }}>La cancelación en línea solo está disponible hasta 24 horas antes.</span>
                ) : <span />}
                <button type="button" className="wjbk-btn-ghost" onClick={onClose}>Hacer otra consulta</button>
            </div>
        </div>
    );
}

export const versoComponentDef = {
    category: "Reservas",
    fields: {
        serviceId: { type: "number", label: "Servicio (ID — 0 = mostrar selector)" },
        accentColor: { type: "text", label: "Color de acento (hex)" },
        elementId: { type: "text", label: "ID / Ancla (opcional)" },
    },
    defaultProps: {
        serviceId: 0,
        accentColor: "#3b82f6",
        elementId: "",
    },
};

export default function BookingsVerso({ serviceId, accentColor, elementId }) {
    const [services, setServices] = useState(null); // null = loading, [] = empty/unavailable
    const [service, setService] = useState(null);
    const [date, setDate] = useState("");
    const [slots, setSlots] = useState(null);       // null = not loaded yet
    const [time, setTime] = useState("");
    const [form, setForm] = useState({ name: "", email: "", phone: "", notes: "", hp: "" });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState(null);         // { token, emailSent, message }
    const formShownAt = useRef(0);

    // Lookup (status/cancel) state — driven by ?booking=token or the manual code input.
    const [lookupOpen, setLookupOpen] = useState(false);
    const [lookupCode, setLookupCode] = useState("");
    const [lookupBusy, setLookupBusy] = useState(false);
    const [lookupError, setLookupError] = useState("");
    const [lookupBooking, setLookupBooking] = useState(null);
    const [cancelBusy, setCancelBusy] = useState(false);
    const [cancelMsg, setCancelMsg] = useState(null); // { ok: boolean, text: string }

    const preselected = Number(serviceId) > 0;
    const days = nextDays(30);

    // Load active services.
    useEffect(() => {
        let alive = true;
        fetch(`${API}/public/services`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (!alive) return;
                const list = (data && data.services) || [];
                setServices(list);
                if (preselected) {
                    const match = list.find((s) => Number(s.id) === Number(serviceId));
                    setService(match || null);
                }
            })
            .catch(() => { if (alive) setServices([]); });
        return () => { alive = false; };
    }, [serviceId, preselected]);

    // Handle ?booking=<token> on mount (window guarded — SSR/iframe safe).
    useEffect(() => {
        if (typeof window === "undefined") return;
        try {
            const params = new URLSearchParams(window.location.search);
            const tok = (params.get("booking") || "").trim();
            if (tok) {
                setLookupOpen(true);
                setLookupCode(tok);
                doLookup(tok);
            }
        } catch { /* ignore */ }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Load slots whenever service+date are picked.
    useEffect(() => {
        if (!service || !date) { setSlots(null); return; }
        let alive = true;
        setSlots(null);
        setTime("");
        fetch(`${API}/public/slots?service_id=${encodeURIComponent(service.id)}&date=${encodeURIComponent(date)}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => { if (alive) setSlots((data && data.slots) || []); })
            .catch(() => { if (alive) setSlots([]); });
        return () => { alive = false; };
    }, [service, date]);

    // Start the anti-spam clock when the customer form becomes visible.
    useEffect(() => {
        if (service && date && time) formShownAt.current = Date.now();
    }, [service, date, time]);

    const refreshSlots = () => {
        // Re-run the slots effect by re-setting date (same value triggers nothing) — fetch directly.
        if (!service || !date) return;
        setSlots(null);
        setTime("");
        fetch(`${API}/public/slots?service_id=${encodeURIComponent(service.id)}&date=${encodeURIComponent(date)}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => setSlots((data && data.slots) || []))
            .catch(() => setSlots([]));
    };

    const submit = async (e) => {
        e.preventDefault();
        if (busy) return;
        setError("");
        if (!form.name.trim()) { setError("Escribe tu nombre."); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) { setError("Escribe un email válido."); return; }
        setBusy(true);
        try {
            const res = await fetch(`${API}/public/book`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    service_id: service.id,
                    date,
                    time,
                    customer_name: form.name.trim(),
                    customer_email: form.email.trim(),
                    customer_phone: form.phone.trim(),
                    notes: form.notes.trim(),
                    hp: form.hp,
                    elapsed: Date.now() - (formShownAt.current || 0),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(data.error || "No se pudo crear la reserva. Intenta de nuevo.");
                if (res.status === 409) refreshSlots();
                return;
            }
            setDone(data);
        } catch {
            setError("No se pudo conectar. Intenta de nuevo.");
        } finally {
            setBusy(false);
        }
    };

    const doLookup = async (tok) => {
        const code = String(tok || "").trim();
        if (!code) { setLookupError("Escribe el código de tu reserva."); return; }
        setLookupBusy(true);
        setLookupError("");
        setLookupBooking(null);
        setCancelMsg(null);
        try {
            const res = await fetch(`${API}/public/booking?token=${encodeURIComponent(code)}`);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) { setLookupError(data.error || "No se encontró la reserva."); return; }
            setLookupBooking({ ...data.booking, token: code });
        } catch {
            setLookupError("No se pudo conectar. Intenta de nuevo.");
        } finally {
            setLookupBusy(false);
        }
    };

    const doCancel = async () => {
        if (!lookupBooking || cancelBusy) return;
        setCancelBusy(true);
        setCancelMsg(null);
        try {
            const res = await fetch(`${API}/public/cancel`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: lookupBooking.token }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) { setCancelMsg({ ok: false, text: data.error || "No se pudo cancelar la reserva." }); return; }
            setLookupBooking({ ...lookupBooking, status: "cancelled", canCancel: false });
            setCancelMsg({ ok: true, text: "Reserva cancelada correctamente." });
        } catch {
            setCancelMsg({ ok: false, text: "No se pudo conectar. Intenta de nuevo." });
        } finally {
            setCancelBusy(false);
        }
    };

    const resetAll = () => {
        setDone(null);
        setError("");
        setTime("");
        setDate("");
        setForm({ name: "", email: "", phone: "", notes: "", hp: "" });
        if (!preselected) setService(null);
        setSlots(null);
    };

    const accent = /^#[0-9a-fA-F]{3,8}$/.test(String(accentColor || "")) ? accentColor : "#3b82f6";
    const todayStr = dateStr(new Date());
    const maxDate = dateStr(new Date(Date.now() + 90 * 86400000));

    return (
        <div id={elementId || undefined} className="wjbk-root" style={{ "--wjbk-a": accent }}>
            <style dangerouslySetInnerHTML={{ __html: STYLES }} />

            {/* ── lookup view (via ?booking= or manual code) ── */}
            {lookupBooking ? (
                <StatusView
                    booking={lookupBooking}
                    cancelBusy={cancelBusy}
                    cancelMsg={cancelMsg}
                    onCancel={doCancel}
                    onClose={() => { setLookupBooking(null); setLookupCode(""); setCancelMsg(null); }}
                />
            ) : done ? (
                /* ── success view ── */
                <div className="wjbk-card">
                    <p className="wjbk-title">¡Reserva confirmada! 🎉</p>
                    <div className="wjbk-summary">
                        <div><strong>{service ? service.name : ""}</strong></div>
                        <div>{date} a las {time}</div>
                    </div>
                    <p className="wjbk-sub" style={{ marginBottom: "0.25rem" }}>
                        Guarda este código para consultar o cancelar tu reserva:
                    </p>
                    <div className="wjbk-token">{done.token}</div>
                    <div className={done.emailSent ? "wjbk-ok" : "wjbk-error"}>
                        {done.emailSent
                            ? "Te enviamos un correo con los detalles y el código."
                            : "No se pudo enviar el correo de confirmación — anota el código antes de salir."}
                    </div>
                    <div className="wjbk-row" style={{ marginTop: "0.75rem" }}>
                        <button type="button" className="wjbk-btn-ghost" onClick={resetAll}>Hacer otra reserva</button>
                        <button type="button" className="wjbk-btn-ghost" onClick={() => { setLookupOpen(true); setLookupCode(done.token); doLookup(done.token); }}>
                            Ver estado de la reserva
                        </button>
                    </div>
                </div>
            ) : (
                /* ── booking wizard ── */
                <div className="wjbk-card">
                    {services === null ? (
                        <div className="wjbk-empty">Cargando servicios…</div>
                    ) : services.length === 0 ? (
                        <div className="wjbk-empty">Las reservas no están disponibles por el momento.</div>
                    ) : preselected && !service ? (
                        <div className="wjbk-empty">El servicio configurado no está disponible.</div>
                    ) : (
                        <>
                            {/* Step 1: service */}
                            {!preselected && (
                                <>
                                    <p className="wjbk-title">1. Elige un servicio</p>
                                    <ServicePicker services={services} selectedId={service ? service.id : null} onPick={(s) => { setService(s); setDate(""); setTime(""); }} />
                                </>
                            )}
                            {preselected && service && (
                                <div className="wjbk-summary" style={{ marginTop: 0 }}>
                                    <strong>{service.name}</strong> · {service.duration_min} min
                                    {Number(service.price_cents) > 0 ? ` · ${fmtPrice(service.price_cents)}` : ""}
                                </div>
                            )}

                            {/* Step 2: date */}
                            {service && (
                                <>
                                    <p className="wjbk-title" style={{ marginTop: "1rem" }}>{preselected ? "1" : "2"}. Elige el día</p>
                                    <DayStrip days={days} selected={date} onPick={(ds) => { setDate(ds); setTime(""); }} />
                                    <div style={{ marginTop: "0.35rem" }}>
                                        <label className="wjbk-label" style={{ display: "inline-block", marginRight: "0.5rem" }}>Otra fecha:</label>
                                        <input
                                            type="date"
                                            className="wjbk-input"
                                            style={{ width: "auto", display: "inline-block" }}
                                            min={todayStr}
                                            max={maxDate}
                                            value={date}
                                            onChange={(e) => { setDate(e.target.value); setTime(""); }}
                                        />
                                    </div>
                                </>
                            )}

                            {/* Step 3: slot */}
                            {service && date && (
                                <>
                                    <p className="wjbk-title" style={{ marginTop: "1rem" }}>{preselected ? "2" : "3"}. Elige el horario</p>
                                    {slots === null ? (
                                        <p className="wjbk-sub">Cargando horarios…</p>
                                    ) : slots.length === 0 ? (
                                        <p className="wjbk-sub">No hay horarios disponibles ese día. Prueba otra fecha.</p>
                                    ) : (
                                        <div className="wjbk-slots">
                                            {slots.map((s) => (
                                                <button key={s} type="button" className={`wjbk-slot${s === time ? " wjbk-sel" : ""}`} onClick={() => setTime(s)}>
                                                    {s}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}

                            {/* Step 4: customer form */}
                            {service && date && time && (
                                <form className="wjbk-form" onSubmit={submit}>
                                    <p className="wjbk-title" style={{ margin: "1rem 0 0" }}>{preselected ? "3" : "4"}. Tus datos</p>
                                    <div className="wjbk-summary">
                                        <strong>{service.name}</strong> · {date} a las {time} · {service.duration_min} min
                                        {Number(service.price_cents) > 0 ? ` · ${fmtPrice(service.price_cents)}` : ""}
                                    </div>
                                    <div>
                                        <label className="wjbk-label">Nombre *</label>
                                        <input className="wjbk-input" type="text" value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                                    </div>
                                    <div>
                                        <label className="wjbk-label">Email *</label>
                                        <input className="wjbk-input" type="email" value={form.email} maxLength={200} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
                                    </div>
                                    <div>
                                        <label className="wjbk-label">Teléfono</label>
                                        <input className="wjbk-input" type="tel" value={form.phone} maxLength={40} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                                    </div>
                                    <div>
                                        <label className="wjbk-label">Notas</label>
                                        <textarea className="wjbk-textarea" rows={3} value={form.notes} maxLength={1000} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                                    </div>
                                    {/* Honeypot — invisible to humans, tempting to bots */}
                                    <div className="wjbk-hp" aria-hidden="true">
                                        <label>No llenar este campo</label>
                                        <input type="text" tabIndex={-1} autoComplete="off" value={form.hp} onChange={(e) => setForm({ ...form, hp: e.target.value })} />
                                    </div>
                                    {error ? <div className="wjbk-error">{error}</div> : null}
                                    <div>
                                        <button type="submit" className="wjbk-btn" disabled={busy}>
                                            {busy ? "Reservando…" : "Confirmar reserva"}
                                        </button>
                                    </div>
                                </form>
                            )}
                        </>
                    )}

                    {/* Inline lookup toggle */}
                    <div style={{ marginTop: "1rem", borderTop: "1px solid var(--wjs-border-subtle, #e5e7eb)", paddingTop: "0.75rem" }}>
                        {!lookupOpen ? (
                            <button type="button" className="wjbk-btn-ghost" style={{ paddingLeft: 0 }} onClick={() => setLookupOpen(true)}>
                                ¿Ya tienes una reserva? Consúltala con tu código →
                            </button>
                        ) : (
                            <div>
                                <label className="wjbk-label">Código de reserva</label>
                                <div className="wjbk-row">
                                    <input
                                        className="wjbk-input"
                                        style={{ flex: 1, minWidth: "200px" }}
                                        type="text"
                                        placeholder="p. ej. k3f9x…"
                                        value={lookupCode}
                                        maxLength={64}
                                        onChange={(e) => setLookupCode(e.target.value)}
                                    />
                                    <button type="button" className="wjbk-btn" disabled={lookupBusy} onClick={() => doLookup(lookupCode)}>
                                        {lookupBusy ? "Buscando…" : "Consultar"}
                                    </button>
                                </div>
                                {lookupError ? <div className="wjbk-error" style={{ marginTop: "0.5rem" }}>{lookupError}</div> : null}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
